// ============================================================================
// TemplatesRoutes - the template builder area's router plus its admin gate.
//
// The shell already hides the Templates nav item from non-admins; this gate
// covers the direct-URL case. Assessors BROWSE published templates in the app;
// the builder (drafting, publishing, the paragraph library) is admin ground.
// The gate is presentation only - the real boundary is the database rules
// (templateDrafts and standardParagraphs are admin-writable) - so the panel is
// calm, not alarmed: nothing was breached, the page just is not theirs.
//
// The builder itself is code-split behind React.lazy: it is by far the
// heaviest screen in the area and the list pages should not pay for it.
// ============================================================================

import { Suspense, lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { EmptyState } from '../ui/Page';
import { LoadingNote } from '../customers/shared';
import { TemplatesList } from './TemplatesList';
import { TemplateVersions } from './TemplateVersions';
import { ParagraphLibrary } from './ParagraphLibrary';

const TemplateBuilder = lazy(() =>
  import('./TemplateBuilder').then((module) => ({
    default: module.TemplateBuilder,
  })),
);

export function TemplatesRoutes() {
  const { claims } = useAuth();
  if (claims?.roles.admin !== true) {
    return (
      <EmptyState
        title="Administrator access required"
        body="Building and publishing assessment templates is an administrator task. You can still browse and use the published templates from the assessor app. If you believe you should have access here, ask an administrator at your organisation."
      />
    );
  }
  return (
    <Routes>
      <Route index element={<TemplatesList />} />
      <Route
        path="builder/:templateId"
        element={
          <Suspense fallback={<LoadingNote>Loading the builder</LoadingNote>}>
            <TemplateBuilder />
          </Suspense>
        }
      />
      <Route path=":templateId/versions" element={<TemplateVersions />} />
      <Route path="paragraphs" element={<ParagraphLibrary />} />
    </Routes>
  );
}
