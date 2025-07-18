import Tooltip from '@mui/material/Tooltip';
import { IconButton, List, ListItemButton, ListItemIcon, ListItemText } from '@mui/material';
import moment from 'moment/moment';
import { EmailOutlined, MoreVert } from '@mui/icons-material';
import React, { Fragment, MouseEvent, useState } from 'react';
import { FileOutline, FilePdfBox, LanguageHtml5, LanguageMarkdownOutline, NoteTextOutline } from 'mdi-material-ui';
import { FileLineDeleteMutation as deleteMutation } from '@components/common/files/FileLine';
import { FileLineDeleteMutation } from '@components/common/files/__generated__/FileLineDeleteMutation.graphql';
import MenuItem from '@mui/material/MenuItem';
import Menu from '@mui/material/Menu';
import { Link } from 'react-router-dom';
import useDeletion from 'src/utils/hooks/useDeletion';
import DeleteDialog from 'src/components/DeleteDialog';
import StixCoreObjectFileExport, { BUILT_IN_HTML_TO_PDF } from '@components/common/stix_core_objects/StixCoreObjectFileExport';
import ListItem from '@mui/material/ListItem';
import { useTheme } from '@mui/styles';
import Drawer from '@components/common/drawer/Drawer';
import StixCoreObjectContentFilesDissemination from '@components/common/stix_core_objects/StixCoreObjectContentFilesDissemination';
import { useFormatter } from '../../../../components/i18n';
import useApiMutation from '../../../../utils/hooks/useApiMutation';
import { APP_BASE_PATH } from '../../../../relay/environment';
import ItemMarkings from '../../../../components/ItemMarkings';
import type { Theme } from '../../../../components/Theme';
import { KNOWLEDGE_KNASKIMPORT, KNOWLEDGE_KNDISSEMINATION, KNOWLEDGE_KNGETEXPORT, KNOWLEDGE_KNUPLOAD } from '../../../../utils/hooks/useGranted';
import Security from '../../../../utils/Security';
import useEnterpriseEdition from '../../../../utils/hooks/useEnterpriseEdition';
import EETooltip from '../entreprise_edition/EETooltip';
import useDraftContext from '../../../../utils/hooks/useDraftContext';

const renderIcon = (mimeType: string) => {
  switch (mimeType) {
    case 'text/plain':
      return <NoteTextOutline />;
    case 'application/pdf':
      return <FilePdfBox />;
    case 'text/markdown':
      return <LanguageMarkdownOutline />;
    case 'text/html':
      return <LanguageHtml5 />;
    default:
      return <FileOutline />;
  }
};

export interface ContentFile {
  id: string
  lastModified: string
  name: string
  metaData: {
    mimetype: string | null | undefined
  } | null | undefined
  objectMarking?: readonly {
    readonly id: string;
    readonly definition?: string | null ;
    readonly x_opencti_color?: string | null ;
  }[];
}

interface StixCoreObjectContentFilesListProps {
  files: ContentFile[],
  stixCoreObjectId: string,
  stixCoreObjectName: string,
  stixCoreObjectType: string,
  currentFileId: string,
  handleSelectFile: (fileId: string) => void,
  onFileChange: (fileName?: string, isDeleted?: boolean) => void,
}

const StixCoreObjectContentFilesList = ({
  files,
  stixCoreObjectId,
  stixCoreObjectName,
  stixCoreObjectType,
  currentFileId,
  handleSelectFile,
  onFileChange,
}: StixCoreObjectContentFilesListProps) => {
  const theme = useTheme<Theme>();
  const { fld, t_i18n } = useFormatter();
  const draftContext = useDraftContext();
  const deletion = useDeletion({});
  const { setDeleting, handleOpenDelete, handleCloseDelete, deleting } = deletion;
  const isEnterpriseEdition = useEnterpriseEdition();

  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [menuFile, setMenuFile] = useState<ContentFile | null>(null);
  const [isDrawerOpen, setDrawerOpen] = useState(false);

  const openPopover = (e: MouseEvent<HTMLButtonElement>, file: ContentFile) => {
    e.stopPropagation();
    setAnchorEl(e.currentTarget);
    setMenuFile(file);
  };
  const closePopover = () => {
    setAnchorEl(null);
    setMenuFile(null);
  };

  const [commitDelete] = useApiMutation<FileLineDeleteMutation>(deleteMutation);
  const submitDelete = () => {
    closePopover();
    if (!menuFile?.id) return;
    handleCloseDelete();
    setDeleting(true);
    commitDelete({
      variables: { fileName: menuFile.id },
      onCompleted: () => {
        setDeleting(false);
        onFileChange(menuFile.id, true);
      },
    });
  };

  const handleDelete = () => handleOpenDelete();

  const handleClose = () => {
    handleCloseDelete();
    closePopover();
  };

  const handleDisseminate = (e: MouseEvent<HTMLButtonElement>, file: ContentFile) => {
    e.stopPropagation();
    setMenuFile(file);
    return setDrawerOpen(true);
  };

  const canDownloadAsPdf = menuFile?.metaData?.mimetype === 'text/html' || menuFile?.metaData?.mimetype === 'text/markdown';

  return (
    <List>
      {files.length === 0 && <ListItem dense={true} divider={true} />}
      {files.map((file) => {
        const fileMimeType = file.metaData?.mimetype ?? '';
        const canDisseminate = !draftContext && ['application/pdf', 'text/html'].includes(fileMimeType);

        return (
          <Fragment key={file.id}>
            <Tooltip title={`${file.name} (${fileMimeType})`}>
              <ListItem
                dense={true}
                divider={true}
                disablePadding
                secondaryAction={
                  <>
                    {canDisseminate && (
                      <Security needs={[KNOWLEDGE_KNDISSEMINATION]}>
                        <>
                          <EETooltip title={t_i18n('Disseminate')}>
                            <IconButton
                              onClick={(e) => handleDisseminate(e, file)}
                              size="small"
                              style={{ color: isEnterpriseEdition ? theme.palette.ee.main : '' }}
                              aria-label="disseminate"
                              disabled={!isEnterpriseEdition}
                            >
                              <EmailOutlined />
                            </IconButton>
                          </EETooltip>
                        </>
                      </Security>
                    )}
                    <IconButton
                      onClick={(e) => openPopover(e, file)}
                      aria-haspopup="true"
                      color="primary"
                      size="small"
                    >
                      <MoreVert />
                    </IconButton>
                  </>
                }
              >
                <ListItemButton
                  selected={file.id === currentFileId}
                  onClick={() => handleSelectFile(file.id)}
                  disabled={deleting}
                >
                  <ListItemIcon>
                    {renderIcon(fileMimeType)}
                  </ListItemIcon>
                  <ListItemText
                    sx={{
                      '.MuiListItemText-primary': {
                        overflowX: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        marginRight: '20px',
                      },
                    }}
                    primary={file.name}
                    secondary={(
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ paddingBottom: theme.spacing(0.5) }}>
                          {fld(file.lastModified ?? moment())}
                        </span>
                        <ItemMarkings
                          markingDefinitions={file.objectMarking ?? []}
                          limit={1}
                        />
                      </div>
                )}
                  />
                </ListItemButton>
              </ListItem>
            </Tooltip>
            {canDisseminate && isEnterpriseEdition && (
            <Security needs={[KNOWLEDGE_KNDISSEMINATION]}>
              <Drawer
                title={t_i18n('Disseminate a file')}
                open={isDrawerOpen}
                onClose={() => setDrawerOpen(false)}
              >
                <StixCoreObjectContentFilesDissemination
                  entityId={stixCoreObjectId}
                  fileId={menuFile?.id ?? ''}
                  fileName={menuFile?.name ?? ''}
                  fileType={menuFile?.metaData?.mimetype ?? ''}
                  onClose={() => setDrawerOpen(false)}
                />
              </Drawer>
            </Security>
            )}
          </Fragment>
        );
      })}

      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={closePopover}
      >
        {menuFile && (
        <MenuItem
          component={Link}
          to={`${APP_BASE_PATH}/storage/get/${encodeURIComponent(menuFile.id)}`}
          onClick={closePopover}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t_i18n('Download file')}
        </MenuItem>
        )}
        {!draftContext && canDownloadAsPdf && (
        <Security needs={[KNOWLEDGE_KNUPLOAD, KNOWLEDGE_KNGETEXPORT]} matchAll>
          <StixCoreObjectFileExport
            onClose={() => setAnchorEl(null)}
            scoId={stixCoreObjectId}
            scoName={stixCoreObjectName}
            scoEntityType={stixCoreObjectType}
            defaultValues={{
              connector: BUILT_IN_HTML_TO_PDF.value,
              format: 'application/pdf',
              fileToExport: menuFile.id,
            }}
            onExportCompleted={onFileChange}
            OpenFormComponent={({ onOpen }) => (
              <MenuItem onClick={onOpen}>
                {t_i18n('Generate a PDF export')}
              </MenuItem>
            )}
          />
        </Security>
        )}
        <Security needs={[KNOWLEDGE_KNASKIMPORT]} matchAll>
          <MenuItem onClick={handleDelete}>
            {t_i18n('Delete')}
          </MenuItem>
        </Security>
        <DeleteDialog
          deletion={deletion}
          submitDelete={submitDelete}
          onClose={handleClose}
          message={t_i18n('Do you want to delete this file?')}
        />
      </Menu>
    </List>
  );
};

export default StixCoreObjectContentFilesList;
