// A stand-in for `firebase/storage` in component tests. Stored files are
// fetched as blobs (src/console/lib/useStoredFileUrl.ts), so a test controls
// which objects exist and gets predictable `blob:<path>` object URLs back.
//
// Use: vi.mock('firebase/storage', async () => (await import('<rel>/test/storageMock')).storageModule)
// then storageMock.missing.add(path) to make one object unreadable.

interface MockRef {
  fullPath: string;
  name: string;
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

export const storageMock = {
  /** Paths whose reads are refused (missing object, or denied by the rules). */
  missing: new Set<string>(),
  /** Every path getBlob was asked for, in order. */
  fetched: [] as string[],
  /** MIME type to serve for a path, overriding the one its extension implies. */
  types: new Map<string, string>(),
  /** The last blob handed to URL.createObjectURL. */
  lastObjectBlob: null as Blob | null,
  reset() {
    this.missing.clear();
    this.fetched.length = 0;
    this.types.clear();
    this.lastObjectBlob = null;
  },
};

function ref(_storage: unknown, reference: string): MockRef {
  // A download URL names its object between /o/ and the query, encoded.
  const fromUrl = /\/o\/([^?]+)/.exec(reference);
  const fullPath = fromUrl ? decodeURIComponent(fromUrl[1]) : reference;
  return { fullPath, name: fullPath.split('/').pop() ?? fullPath };
}

async function getMetadata(fileRef: MockRef) {
  if (storageMock.missing.has(fileRef.fullPath)) {
    throw new Error('storage/object-not-found');
  }
  return { fullPath: fileRef.fullPath };
}

async function getBlob(fileRef: MockRef): Promise<Blob> {
  storageMock.fetched.push(fileRef.fullPath);
  if (storageMock.missing.has(fileRef.fullPath)) {
    throw new Error('storage/object-not-found');
  }
  const ext = fileRef.name.split('.').pop()?.toLowerCase() ?? '';
  const type =
    storageMock.types.get(fileRef.fullPath) ?? MIME[ext] ?? 'application/octet-stream';
  const blob = new Blob(['x'], { type });
  return Object.assign(blob, { mockPath: fileRef.fullPath });
}

export const storageModule = {
  ref,
  getMetadata,
  getBlob,
  getDownloadURL: async (fileRef: MockRef) =>
    `https://firebasestorage.googleapis.com/mock/${fileRef.fullPath}`,
};

// jsdom has no object URLs; make them deterministic so tests can assert them.
URL.createObjectURL = (blob: Blob) => {
  storageMock.lastObjectBlob = blob;
  return `blob:${(blob as Blob & { mockPath?: string }).mockPath ?? 'local'}`;
};
URL.revokeObjectURL = () => undefined;

/**
 * Click a StoredFileLink and report what it did with the fetched file: shown in
 * a new tab (images) or saved as a download (everything else). Proves the file
 * is fetched through the SDK on click.
 */
export async function activateStoredLink(
  link: HTMLElement,
): Promise<{ via: 'tab' | 'download'; url: string; name?: string }> {
  const { vi, expect } = await import('vitest');
  const { fireEvent, waitFor } = await import('@testing-library/react');
  const tab = {
    closed: false,
    opener: {} as unknown,
    location: { href: '' },
    close: vi.fn(() => {
      tab.closed = true;
    }),
  };
  let saved: { url: string; name: string } | null = null;
  const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      saved = { url: this.href, name: this.download };
    });
  try {
    fireEvent.click(link);
    await waitFor(() => expect(tab.location.href || saved).toBeTruthy());
  } finally {
    open.mockRestore();
    click.mockRestore();
  }
  if (tab.location.href) {
    expect(tab.opener).toBeNull();
    return { via: 'tab', url: tab.location.href };
  }
  const download = saved as unknown as { url: string; name: string };
  return { via: 'download', url: download.url, name: download.name };
}
