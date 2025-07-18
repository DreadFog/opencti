/*
Copyright (c) 2021-2025 Filigran SAS

This file is part of the OpenCTI Enterprise Edition ("EE") and is
licensed under the OpenCTI Enterprise Edition License (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

https://github.com/OpenCTI-Platform/opencti/blob/master/LICENSE

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
*/

import { LRUCache } from 'lru-cache';
import { type ActionHandler, type ActionListener, registerUserActionListener, type UserAction, type UserReadAction } from '../listener/UserActionListener';
import conf, { auditLogTypes, logAudit } from '../config/conf';
import type { BasicStoreSettings } from '../types/settings';
import { EVENT_ACTIVITY_VERSION, storeActivityEvent } from '../database/redis';
import { getEntityFromCache } from '../database/cache';
import { ENTITY_TYPE_SETTINGS, isInternalObject } from '../schema/internalObject';
import { executionContext, SYSTEM_USER } from '../utils/access';
import { ENTITY_TYPE_WORKSPACE } from '../modules/workspace/workspace-types';
import { isStixCoreRelationship } from '../schema/stixCoreRelationship';
import { isStixCoreObject } from '../schema/stixCoreObject';
import { REDACTED_INFORMATION } from '../database/utils';
import type { ActivityStreamEvent } from '../types/event';

const INTERNAL_READ_ENTITIES = [ENTITY_TYPE_WORKSPACE];
const LOGS_SENSITIVE_FIELDS = conf.get('app:app_logs:logs_redacted_inputs') ?? [];
const UNSUPPORTED_INTPUT_PROPS = ['_id', 'sort', 'i_attributes', 'i_relation']; // add 'objectOrganization' ?
export const EVENT_SCOPE_VALUES = ['create', 'update', 'delete', 'read', 'search', 'enrich', 'download', 'import', 'export', 'login', 'logout', 'unauthorized', 'disseminate', 'forgot'];
export const EVENT_TYPE_VALUES = ['authentication', 'read', 'mutation', 'file', 'command'];
export const EVENT_ACCESS_VALUES = ['extended', 'administration'];
export const EVENT_STATUS_VALUES = ['error', 'success'];

const initActivityManager = () => {
  const activityReadCache = new LRUCache({ ttl: 60 * 60 * 1000, max: 5000 }); // Read lifetime is 1 hour
  const cleanInputData = (obj: any) => {
    const stack = [obj];
    while (stack.length > 0) {
      const currentObj = stack.pop() as any;
      Object.keys(currentObj).forEach((key) => {
        if (LOGS_SENSITIVE_FIELDS.includes(key)) {
          currentObj[key] = REDACTED_INFORMATION;
        }
        // Need special case to clean inputs
        if (key === 'input' && Array.isArray(currentObj[key])) {
          const preparedElements = [];
          for (let index = 0; index < currentObj[key].length; index += 1) {
            const currentObjElementElement = currentObj[key][index];
            if (currentObjElementElement.key && currentObjElementElement.value && LOGS_SENSITIVE_FIELDS.includes(currentObjElementElement.key)) {
              preparedElements.push({ [currentObjElementElement.key]: REDACTED_INFORMATION });
            } else {
              preparedElements.push(currentObjElementElement);
            }
          }
          currentObj[key] = preparedElements;
        }
        if (typeof currentObj[key] === 'object' && currentObj[key] !== null) {
          if (key === 'input') {
            // remove unsupported props in input like sort, _id that cause errors for old databases.
            UNSUPPORTED_INTPUT_PROPS.forEach((prop) => {
              delete currentObj[key][prop];
            });
          }
          stack.push(currentObj[key]);
        }
      });
    }
    return obj;
  };
  const buildActivityStreamEvent = (action: UserAction, message: string): ActivityStreamEvent => {
    const data = cleanInputData(action.context_data ?? {});
    return {
      version: EVENT_ACTIVITY_VERSION,
      type: action.event_type,
      event_access: action.event_access,
      event_scope: action.event_scope,
      prevent_indexing: action.prevent_indexing ?? false,
      status: action.status ?? 'success',
      origin: action.user.origin,
      message,
      data,
    };
  };
  const activityLogger = async (action: UserAction, message: string): Promise<boolean> => {
    const level = action.status === 'error' ? 'error' : 'info';
    // If standard action, log and push to activity stream.
    const event = buildActivityStreamEvent(action, message);
    const meta = {
      version: event.version,
      type: event.type,
      event_scope: event.event_scope,
      event_access: event.event_access,
      data: event.data
    };
    // In admin case put that to logs/console
    if (auditLogTypes.includes(action.event_access)) {
      logAudit._log(level, action.user, message, meta);
    }
    // In all case, store in history
    await storeActivityEvent(event);
    return true;
  };
  const readActivity = async (action: UserReadAction) => {
    const { id, entity_type, entity_name } = action.context_data;
    const identifier = `${id}-${action.user.id}`;
    // Auto read only for stix knowledge, for other internal elements, it must be
    if (!activityReadCache.has(identifier)) {
      const message = `reads \`${entity_name}\` (${entity_type})`;
      const published = await activityLogger(action, message);
      if (published) {
        activityReadCache.set(identifier, 'published');
      }
    }
  };
  const activityHandler: ActionListener = {
    id: 'ACTIVITY_MANAGER',
    next: async (action: UserAction) => {
      const context = executionContext('activity_listener');
      const settings = await getEntityFromCache<BasicStoreSettings>(context, SYSTEM_USER, ENTITY_TYPE_SETTINGS);
      // 01. Check activity authorization
      if (!['query', 'internal'].includes(action.user.origin?.socket ?? '')) { // Subscription is not part of the listening
        return;
      }
      if (settings.valid_enterprise_edition !== true) { // If enterprise edition is not activated
        return;
      }
      const isUserListening = (settings.activity_listeners_users ?? []).includes(action.user.id);
      if (action.event_access === 'extended' && !isUserListening) { // If extended actions, is action is not for listened user
        return;
      }
      // 02. Handle activities
      if (action.event_type === 'authentication') {
        if (action.event_scope === 'login') {
          const { provider, username } = action.context_data;
          const isFailLogin = action.status === 'error';
          const message = isFailLogin ? `detects \`login failure\` for \`${username}\``
            : `login from provider \`${provider}\``;
          await activityLogger(action, message);
        }
        if (action.event_scope === 'logout') {
          await activityLogger(action, 'logout');
        }
        if (action.event_scope === 'forgot') {
          await activityLogger(action, action.message);
        }
      }
      if (action.event_type === 'read') {
        if (action.event_scope === 'unauthorized') {
          const message = `tries an \`unauthorized ${action.event_type}\``;
          await activityLogger(action, message);
        }
        if (action.event_scope === 'read') {
          const { entity_type } = action.context_data;
          const isKnowledgeListening = isStixCoreObject(entity_type) || isStixCoreRelationship(entity_type);
          const isInternalListening = isInternalObject(entity_type) && INTERNAL_READ_ENTITIES.includes(entity_type);
          if (isKnowledgeListening || isInternalListening) {
            await readActivity(action);
          }
        }
      }
      if (action.event_type === 'file') {
        const isFailAction = action.status === 'error';
        const prefixMessage = isFailAction ? 'failure ' : '';
        if (action.event_scope === 'read') {
          const { file_name, entity_name } = action.context_data;
          const message = `${prefixMessage} reads from \`${entity_name}\` the file \`${file_name}\``;
          await activityLogger(action, message);
        }
        if (action.event_scope === 'download') {
          const { file_name, entity_name } = action.context_data;
          const message = `${prefixMessage}  downloads from \`${entity_name}\` the file \`${file_name}\``;
          await activityLogger(action, message);
        }
        if (action.event_scope === 'create') {
          const { file_name, entity_name, entity_type, path, input } = action.context_data;
          // @ts-expect-error input type unknown
          let message = input?.is_upsert
            ? `adds a new version of \`${file_name}\` in \`files\` for \`${entity_name}\` (${entity_type})`
            : `adds \`${file_name}\` in \`files\` for \`${entity_name}\` (${entity_type})`;
          if (path.includes('import/pending')) {
            message = `creates Analyst Workbench \`${file_name}\` for \`${entity_name}\` (${entity_type})`;
          }
          await activityLogger(action, message);
        }
        if (action.event_scope === 'delete') { // General upload
          const { file_name, entity_name, entity_type, path } = action.context_data;
          let message = `removes \`${file_name}\` in \`files\` for \`${entity_name}\` (${entity_type})`;
          if (path.includes('import/pending')) {
            message = `removes Analyst Workbench \`${file_name}\` for \`${entity_name}\` (${entity_type})`;
          }
          await activityLogger(action, message);
        }
        if (action.event_scope === 'disseminate') {
          const { entity_name, entity_type, input } = action.context_data;
          // @ts-expect-error input type unknown
          const message = `disseminate \`${input.files.map((f) => f.name).join(',')}\` to \`${input.dissemination}\` from \`${entity_name}\` (${entity_type})`;
          await activityLogger(action, message);
        }
      }
      if (action.event_type === 'command') {
        if (action.event_scope === 'search') {
          const message = 'asks for `global search`';
          await activityLogger(action, message);
        }
        if (action.event_scope === 'export') {
          const { format, entity_name } = action.context_data;
          const message = `asks for \`${format}\` export in \`${entity_name}\``;
          await activityLogger(action, message);
        }
        if (action.event_scope === 'import') {
          const { file_name, file_mime, entity_name } = action.context_data;
          const message = `asks for \`${file_mime}\` import of \`${file_name}\` in \`${entity_name}\``;
          await activityLogger(action, message);
        }
        if (action.event_scope === 'enrich') {
          const { entity_name, connector_name } = action.context_data;
          const message = `asks for \`${entity_name}\` enrichment with connector \`${connector_name}\``;
          await activityLogger(action, message);
        }
        if (action.event_scope === 'analyze') {
          const { entity_name, connector_name } = action.context_data;
          const message = `asks for \`${entity_name}\` analysis with connector \`${connector_name}\``;
          await activityLogger(action, message);
        }
      }
      if (action.event_type === 'mutation') {
        if (action.event_scope === 'unauthorized') {
          const message = `tries an \`unauthorized ${action.event_type}\``;
          await activityLogger(action, message);
        }
        if (action.event_scope === 'create') {
          await activityLogger(action, action.message);
        }
        if (action.event_scope === 'update') {
          await activityLogger(action, action.message);
        }
        if (action.event_scope === 'delete') {
          await activityLogger(action, action.message);
        }
      }
    }
  };
  let handler: ActionHandler;
  return {
    start: async () => {
      handler = registerUserActionListener(activityHandler);
    },
    status: () => {
      return {
        id: 'ACTIVITY_MANAGER',
        enable: true,
        running: true,
      };
    },
    shutdown: async () => {
      if (handler) {
        handler.unregister();
      }
      return true;
    },
  };
};
const activityListener = initActivityManager();
export default activityListener;
