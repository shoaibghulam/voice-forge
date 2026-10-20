/** Per-file tus upload state for a singer's songs. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type * as tus from 'tus-js-client';
import { keys } from '@/api/hooks';
import type { ErrorText } from '@/api/errors';
import type { Era } from '@/api/schemas';
import { AUDIO_EXTENSIONS, startTusUpload } from '@/features/shared/tus';

export type UploadStatus = 'uploading' | 'done' | 'error' | 'stopped';

export interface UploadItem {
  key: string;
  name: string;
  size: number;
  sent: number;
  era: Era;
  status: UploadStatus;
  error: ErrorText | null;
}

let counter = 0;

export function useSongUploads(singerId: string) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const uploads = useRef(new Map<string, tus.Upload>());
  const qc = useQueryClient();

  const patch = useCallback((key: string, change: Partial<UploadItem>) => {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...change } : item)));
  }, []);

  useEffect(() => {
    const live = uploads.current;
    return () => {
      for (const upload of live.values()) void upload.abort().catch(() => undefined);
      live.clear();
    };
  }, []);

  const add = useCallback((files: File[], era: Era) => {
    const fresh: UploadItem[] = files.map((file) => {
      counter += 1;
      return { key: `u${counter}`, name: file.name, size: file.size, sent: 0, era, status: 'uploading', error: null };
    });
    setItems((prev) => [...fresh, ...prev]);
    files.forEach((file, i) => {
      const item = fresh[i];
      if (!item) return;
      if (!AUDIO_EXTENSIONS.test(file.name)) {
        patch(item.key, {
          status: 'error',
          error: { title: `"${file.name}" is not a supported audio file.`, help: 'Use MP3, WAV, FLAC, M4A, OGG, OPUS or AAC.' },
        });
        return;
      }
      const upload = startTusUpload(file, { purpose: 'dataset', singer_id: singerId, era }, {
        onProgress: (sent) => patch(item.key, { sent }),
        onSuccess: () => {
          uploads.current.delete(item.key);
          patch(item.key, { status: 'done', sent: file.size });
          void qc.invalidateQueries({ queryKey: keys.songs(singerId) });
          void qc.invalidateQueries({ queryKey: keys.singer(singerId) });
          void qc.invalidateQueries({ queryKey: keys.singers });
        },
        onError: (error) => {
          uploads.current.delete(item.key);
          patch(item.key, { status: 'error', error });
        },
      });
      uploads.current.set(item.key, upload);
    });
  }, [patch, qc, singerId]);

  const stop = useCallback((key: string) => {
    const upload = uploads.current.get(key);
    uploads.current.delete(key);
    if (upload) void upload.abort().catch(() => undefined);
    patch(key, { status: 'stopped' });
  }, [patch]);

  const dismiss = useCallback((key: string) => {
    setItems((prev) => prev.filter((item) => item.key !== key));
  }, []);

  return { items, add, stop, dismiss };
}
