// Stored-file helpers: files are fetched through the Storage SDK (so App Check
// is sent) and shown from same-origin object URLs. These pin the safety rules
// that come with that: only our own bucket, never active content, one fetch per
// object, and failures that can be retried.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { activateStoredLink, storageMock } from '../../test/storageMock';
import { StoredFileLink, StoredImage } from './StoredFile';

vi.mock('../../firebase', () => ({ firebase: { storage: vi.fn() } }));
vi.mock('firebase/storage', async () => (await import('../../test/storageMock')).storageModule);

let n = 0;
let base = '';
beforeEach(() => {
  storageMock.reset();
  n += 1;
  base = `live/orgs/org-1/files-${n}`;
});

describe('StoredImage', () => {
  it('shows a stored path from a same-origin object URL', async () => {
    const { container } = render(<StoredImage reference={`${base}/a.png`} alt="" />);
    await waitFor(() =>
      expect(container.querySelector('img')).toHaveAttribute('src', `blob:${base}/a.png`),
    );
  });

  it('accepts a download URL for our own bucket', async () => {
    const url =
      'https://firebasestorage.googleapis.com/v0/b/safentia-tech.firebasestorage.app/o/' +
      encodeURIComponent(`${base}/b.png`) +
      '?alt=media&token=t';
    const { container } = render(<StoredImage reference={url} alt="" />);
    await waitFor(() =>
      expect(container.querySelector('img')).toHaveAttribute('src', `blob:${base}/b.png`),
    );
  });

  it('never fetches from another host, and reports it as a failure', async () => {
    const onError = vi.fn();
    const { container } = render(
      <StoredImage reference="https://example.com/logo.png" alt="" onError={onError} />,
    );
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(container.querySelector('img')).toBeNull();
    expect(storageMock.fetched).toHaveLength(0);
  });

  it('passes a local crop preview straight through', () => {
    const { container } = render(<StoredImage reference="blob:local-preview" alt="" />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:local-preview');
    expect(storageMock.fetched).toHaveLength(0);
  });

  it('fetches an object once however many places show it', async () => {
    const path = `${base}/shared.png`;
    const { container } = render(
      <>
        <StoredImage reference={path} alt="" />
        <StoredImage reference={path} alt="" />
      </>,
    );
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(2));
    expect(storageMock.fetched).toEqual([path]);
  });

  it('retries an object that failed once it can be read', async () => {
    const path = `${base}/later.png`;
    storageMock.missing.add(path);
    const onError = vi.fn();
    const first = render(<StoredImage reference={path} alt="" onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalled());
    first.unmount();

    storageMock.missing.delete(path);
    const { container } = render(<StoredImage reference={path} alt="" />);
    await waitFor(() =>
      expect(container.querySelector('img')).toHaveAttribute('src', `blob:${path}`),
    );
    expect(storageMock.fetched).toEqual([path, path]);
  });
});

describe('StoredFileLink', () => {
  it('fetches nothing until it is clicked', () => {
    render(
      <StoredFileLink reference={`${base}/report.pdf`}>Download</StoredFileLink>,
    );
    expect(storageMock.fetched).toHaveLength(0);
  });

  it('downloads a PDF under its file name', async () => {
    render(
      <StoredFileLink reference={`${base}/rep.pdf`} fileName="Survey.pdf">
        Download
      </StoredFileLink>,
    );
    expect(
      await activateStoredLink(screen.getByRole('link', { name: 'Download' })),
    ).toEqual({ via: 'download', url: `blob:${base}/rep.pdf`, name: 'Survey.pdf' });
  });

  it('opens an image in a new tab without leaking the opener', async () => {
    render(<StoredFileLink reference={`${base}/plan.jpg`}>View</StoredFileLink>);
    expect(
      await activateStoredLink(screen.getByRole('link', { name: 'View' })),
    ).toEqual({ via: 'tab', url: `blob:${base}/plan.jpg` });
  });

  it('never renders a stored SVG as a page: it is downloaded as opaque bytes', async () => {
    // Same-origin object URLs would let an uploaded SVG's script run as the console.
    const svg = `${base}/drawing`;
    storageMock.types.set(svg, 'image/svg+xml');
    render(<StoredFileLink reference={svg}>Open</StoredFileLink>);
    const result = await activateStoredLink(screen.getByRole('link', { name: 'Open' }));
    expect(result.via).toBe('download');
    expect(storageMock.lastObjectBlob?.type).toBe('application/octet-stream');
  });

  it('says so when the file cannot be reached', async () => {
    storageMock.missing.add(`${base}/gone.pdf`);
    render(<StoredFileLink reference={`${base}/gone.pdf`}>Download</StoredFileLink>);
    screen.getByRole('link', { name: 'Download' }).click();
    expect(
      await screen.findByText(/The file could not be reached/),
    ).toBeInTheDocument();
  });
});
