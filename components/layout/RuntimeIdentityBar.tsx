"use client";

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import type { RuntimeIdentity } from '@/lib/runtime-identity';
import s from './RuntimeIdentityBar.module.css';

export function RuntimeIdentityBar() {
  const { t } = useI18n();
  const [identity, setIdentity] = useState<RuntimeIdentity | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const refresh = () => setRetry((n) => n + 1);
    const foreground = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', foreground);
    return () => {
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/runtime/identity', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unavailable');
        const value = await response.json();
        if (!value?.environment || !value?.build || !value?.modelsPath) throw new Error('Invalid identity');
        if (!controller.signal.aborted) { setIdentity(value); setFailed(false); }
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [retry]);
  if (!identity) return <div className={s.bar} data-testid="runtime-identity">
    {failed ? <button type="button" onClick={() => { setFailed(false); setRetry((n) => n + 1); }}>{t('runtime.identityRetry')}</button> : t('runtime.identityLoading')}
  </div>;
  return <details className={s.bar} data-testid="runtime-identity" data-environment={identity.environment}>
    <summary>
      <strong>{t(`runtime.environment.${identity.environment}`)}</strong>
      <span>{identity.build.version}</span>
      {identity.build.sourceSha && <span className={s.revision}>{identity.build.sourceSha.slice(0, 7)}{identity.build.dirty ? ' *' : ''}</span>}
      <span className={s.hint}>{t('runtime.identityDetails')}</span>
    </summary>
    <div className={s.details}>
      {identity.environment === 'fixture' && <p>{t('runtime.fixtureHint')}</p>}
      {identity.environment === 'preview' && <p>{t('runtime.previewHint')}</p>}
      <dl>
        <dt>{t('runtime.modelsPath')}</dt><dd>{identity.modelsPath}</dd>
        <dt>{t('runtime.agentPath')}</dt><dd>{identity.agentDir}</dd>
        <dt>{t('runtime.sourcePath')}</dt><dd>{identity.cwd}</dd>
        <dt>{t('runtime.buildTime')}</dt><dd>{identity.build.builtAt || t('common.unknown')}</dd>
      </dl>
      {identity.build.dirty && <p>{t('runtime.dirtyHint')}</p>}
    </div>
  </details>;
}
