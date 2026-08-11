// ============================================================================
// EmailTemplatesPage - the directory of the organisation's authored email
// templates (the TemplatesList precedent, without the draft/publish split:
// email templates have no publish moment, the node IS live).
//
// Creation and duplication write the template node directly - database rules
// make /emailTemplates/{orgId} admin-writable, and the send path degrades to
// the built-in default if a template is unrenderable, so a direct write risks
// no business operation. Deletion is guarded socially instead: a template an
// email type still points at is not deletable here, because deleting it would
// silently flip that type back to the default copy - the notice sends the
// admin to unassign it first.
// ============================================================================

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { push, ref, remove, set } from 'firebase/database';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { firebase } from '../../firebase';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { EmailKindSettings, EmailTemplate } from '../../types';
import { Card } from '../ui/Card';
import { DataTable, type Column } from '../ui/DataTable';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { SkeletonRows } from '../ui/Skeleton';
import { formatDate, toEntries, useOrgScope } from '../customers/shared';
import {
  normaliseEmailTemplate,
  starterTemplate,
  templateWritePayload,
} from './emailEditorModel';
import styles from './EmailTemplatesPage.module.css';

const editorUrl = (templateId: string) => `/app/emails/templates/${templateId}`;

interface TemplateRow {
  id: string;
  template: EmailTemplate;
  /** How many email types currently point at this template. */
  assignedCount: number;
}

// ----------------------------------------------------------------------------
// Per-row actions. Duplicate is immediate (it creates, never destroys); delete
// follows the house two-step inline confirm (the ParagraphLibrary idiom), and
// is REPLACED by a calm notice while any email type references the template.
// ----------------------------------------------------------------------------

function RowActions({
  row,
  onDuplicate,
  onDelete,
}: {
  row: TemplateRow;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <span className={styles.confirmGroup}>
        <span className={styles.confirmPrompt}>Delete "{row.template.name}"?</span>
        <Button
          variant="secondary"
          onClick={() => {
            setConfirming(false);
            onDelete();
          }}
        >
          Delete
        </Button>
        <Button variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </span>
    );
  }

  return (
    <span className={styles.actions}>
      <Button variant="ghost" onClick={onDuplicate} aria-label={`Duplicate ${row.template.name}`}>
        Duplicate
      </Button>
      {row.assignedCount > 0 ? (
        // Not a disabled button: a control that explains itself beats one that
        // ignores clicks. The count says exactly why deletion is unavailable.
        <span className={styles.blockedNote}>
          In use by {row.assignedCount} email {row.assignedCount === 1 ? 'type' : 'types'} - unassign
          it there before deleting.
        </span>
      ) : (
        <Button
          variant="ghost"
          onClick={() => setConfirming(true)}
          aria-label={`Delete ${row.template.name}`}
        >
          Delete
        </Button>
      )}
    </span>
  );
}

// ----------------------------------------------------------------------------
// The page.
// ----------------------------------------------------------------------------

export default function EmailTemplatesPage() {
  // No admin branch here: EmailsRoutes gates the whole area.
  const { ready, orgId, db } = useOrgScope();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const templatesQuery = useRtdbQuery<Record<string, EmailTemplate> | null>({
    key: keys.emailTemplates(orgId),
    path: ready ? db!.emailTemplates(orgId) : '',
    enabled: ready,
  });
  // The kind settings are joined in purely to COUNT references: the assigned
  // column and the delete guard both come from this map.
  const kindsQuery = useRtdbQuery<Record<string, EmailKindSettings> | null>({
    key: keys.emailKindSettings(orgId),
    path: ready ? db!.emailKindSettings(orgId) : '',
    enabled: ready,
  });

  const assignedCounts = new Map<string, number>();
  for (const [, settings] of toEntries(kindsQuery.data)) {
    if (settings?.templateId) {
      assignedCounts.set(
        settings.templateId,
        (assignedCounts.get(settings.templateId) ?? 0) + 1,
      );
    }
  }

  const rows: TemplateRow[] = toEntries(templatesQuery.data)
    .map(([id, template]) => ({
      id,
      template: normaliseEmailTemplate(template),
      assignedCount: assignedCounts.get(id) ?? 0,
    }))
    .sort((a, b) => a.template.name.localeCompare(b.template.name, 'en-GB'));

  const createTemplate = async () => {
    if (!db || !user) return;
    setError(null);
    setCreating(true);
    try {
      const database = firebase.db();
      const key = push(ref(database, db.emailTemplates(orgId))).key;
      if (!key) throw new Error('Could not mint an id');
      await set(
        ref(database, db.emailTemplate(orgId, key)),
        starterTemplate('New template', user.uid),
      );
      navigate(editorUrl(key));
    } catch {
      setError('Could not create the template. Please try again.');
      setCreating(false);
    }
  };

  const duplicateTemplate = async (row: TemplateRow) => {
    if (!db || !user) return;
    setError(null);
    try {
      const database = firebase.db();
      const key = push(ref(database, db.emailTemplates(orgId))).key;
      if (!key) throw new Error('Could not mint an id');
      // Block ids only need uniqueness WITHIN a template, so the copy keeps
      // them; templateWritePayload restamps updatedAt/updatedBy as the copy's
      // own first edit.
      const copy = templateWritePayload(
        { ...row.template, name: `${row.template.name} (copy)` },
        user.uid,
      );
      await set(ref(database, db.emailTemplate(orgId, key)), copy);
      navigate(editorUrl(key));
    } catch {
      setError('Could not duplicate the template. Please try again.');
    }
  };

  const deleteTemplate = async (row: TemplateRow) => {
    if (!db) return;
    setError(null);
    try {
      await remove(ref(firebase.db(), db.emailTemplate(orgId, row.id)));
    } catch {
      setError('Could not delete the template. Please try again.');
    }
  };

  const columns: Array<Column<TemplateRow>> = [
    {
      header: 'Name',
      cell: (row) => row.template.name.trim() || 'Untitled template',
    },
    {
      header: 'Last updated',
      desktopOnly: true,
      cell: (row) => (row.template.updatedAt > 0 ? formatDate(row.template.updatedAt) : '-'),
    },
    {
      header: 'Assigned',
      cell: (row) =>
        row.assignedCount > 0
          ? `Assigned to ${row.assignedCount} ${row.assignedCount === 1 ? 'type' : 'types'}`
          : 'Not assigned',
    },
    {
      header: 'Actions',
      align: 'end',
      width: '1%',
      cell: (row) => (
        <RowActions
          row={row}
          onDuplicate={() => void duplicateTemplate(row)}
          onDelete={() => void deleteTemplate(row)}
        />
      ),
    },
  ];

  const loading = templatesQuery.isLoading || kindsQuery.isLoading;

  return (
    <div className={styles.root}>
      <PageHeader
        title="Email templates"
        lede="The wording your organisation's emails are sent with. Assign a template to an email type to replace the built-in copy; unassigned types keep the default."
        action={
          <Button onClick={() => void createTemplate()} disabled={creating || !ready}>
            {creating ? 'Creating' : 'New template'}
          </Button>
        }
      />

      {error && <ErrorNotice message={error} />}
      {(templatesQuery.isError || kindsQuery.isError) && (
        <ErrorNotice message="Could not load email templates. Please try again." />
      )}

      {loading ? (
        // Honest loading: undefined means the listener is still attaching -
        // only a delivered empty snapshot is a real zero.
        <SkeletonRows rows={3} label="Loading email templates" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No email templates yet"
          body="Every email type currently sends the built-in default copy. Create a template to write your own."
          action={
            <Button onClick={() => void createTemplate()} disabled={creating}>
              New template
            </Button>
          }
        />
      ) : (
        <Card flush>
          <DataTable
            label="Email templates"
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            rowHref={(row) => editorUrl(row.id)}
          />
        </Card>
      )}
    </div>
  );
}
