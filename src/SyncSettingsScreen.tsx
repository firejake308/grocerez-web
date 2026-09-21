import { useState } from 'react';
import { ArrowLeft, Cloud, LogOut, MapPin, RefreshCw } from 'lucide-react';
import type { SyncController } from './sync/useSync';
import type { GeocodeResult } from './sync/api';

const formatWhen = (iso: string | null): string => {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return d.toLocaleDateString();
};

const TIER_LABEL: Record<string, string> = {
  new: 'New contributor',
  restricted: 'Restricted',
  established: 'Established',
  trusted: 'Trusted',
};

const inputClass = 'block w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-gray-900';
const primaryButton = 'w-full py-3 rounded-lg font-medium text-white bg-green-500 hover:bg-green-600 disabled:opacity-50';
const secondaryButton = 'w-full py-2 rounded-lg font-medium text-green-700 border border-green-600 hover:bg-green-50 disabled:opacity-50';

const SyncSettingsScreen = ({ sync, onBack }: { sync: SyncController; onBack: VoidFunction }) => {
  const [email, setEmail] = useState(sync.auth?.email ?? '');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(sync.profile?.displayName ?? sync.auth?.displayName ?? '');
  const [areaQuery, setAreaQuery] = useState('');
  const [areaResults, setAreaResults] = useState<GeocodeResult[] | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <header className="bg-green-600 p-4 shadow-md flex items-center">
        <button onClick={onBack} className="p-2 text-white" aria-label="Back">
          <ArrowLeft size={24} />
        </button>
        <h1 className="text-xl font-semibold text-white ml-2">Community Prices</h1>
      </header>

      <main className="flex-1 p-4 overflow-auto space-y-4">
        {!sync.enabled ? (
          <div className="bg-white rounded-lg shadow p-4 text-gray-600">
            Community price sharing is not configured for this build.
          </div>
        ) : (
          <>
            <section className="bg-white rounded-lg shadow p-4">
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-semibold text-lg text-gray-800">Sync</h2>
                <button
                  onClick={() => void sync.syncNow()}
                  disabled={sync.status.running}
                  className="flex items-center text-sm text-green-700 font-medium disabled:opacity-50"
                >
                  <RefreshCw size={16} className={`mr-1 ${sync.status.running ? 'animate-spin' : ''}`} />
                  {sync.status.running ? 'Syncing…' : 'Sync now'}
                </button>
              </div>
              <dl className="text-sm text-gray-600 space-y-1">
                <div className="flex justify-between"><dt>Last synced</dt><dd>{formatWhen(sync.status.lastSyncedAt)}</dd></div>
                <div className="flex justify-between"><dt>Community prices nearby</dt><dd>{sync.community.length}</dd></div>
                {sync.auth && (
                  <div className="flex justify-between"><dt>Waiting to upload</dt><dd>{sync.status.pendingCount}</dd></div>
                )}
              </dl>
              {sync.status.skippedPull === 'no-location' && (
                <p className="mt-2 text-sm text-amber-700">
                  Set your home area below (or scan a price with location on) so we know which prices to fetch.
                </p>
              )}
              {sync.status.rejected.length > 0 && (
                <p className="mt-2 text-sm text-amber-700">
                  {sync.status.rejected.length} of your scans could not be uploaded: {sync.status.rejected[0].error}
                </p>
              )}
              {sync.status.lastError && <p className="mt-2 text-sm text-red-600">{sync.status.lastError}</p>}
            </section>

            <section className="bg-white rounded-lg shadow p-4">
              <h2 className="font-semibold text-lg text-gray-800 mb-1 flex items-center">
                <MapPin size={18} className="mr-1 text-gray-500" /> Home area
              </h2>
              <p className="text-sm text-gray-500 mb-2">
                Used to fetch prices near you when your location isn't available.
              </p>
              {sync.homeArea && (
                <div className="flex items-center justify-between text-sm text-gray-700 mb-2">
                  <span className="truncate mr-2">{sync.homeArea.label}</span>
                  <button className="text-red-600 shrink-0" onClick={() => void run(() => sync.chooseHomeArea(null))}>Clear</button>
                </div>
              )}
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (areaQuery.trim().length < 2) return;
                  void run(async () => setAreaResults(await sync.searchHomeArea(areaQuery)));
                }}
              >
                <input value={areaQuery} onChange={(e) => setAreaQuery(e.target.value)} placeholder="City or ZIP code" className={inputClass} />
                <button type="submit" disabled={busy || areaQuery.trim().length < 2} className="px-4 rounded-lg bg-blue-500 text-white disabled:opacity-50">Find</button>
              </form>
              {areaResults && (
                <ul className="mt-2 divide-y divide-gray-100">
                  {areaResults.length === 0 && <li className="py-2 text-sm text-gray-500">No matches.</li>}
                  {areaResults.map((r) => (
                    <li key={`${r.lat},${r.lon}`}>
                      <button
                        className="w-full text-left py-2 text-sm text-gray-700 hover:bg-gray-50"
                        onClick={() => {
                          setAreaResults(null);
                          setAreaQuery('');
                          void run(() => sync.chooseHomeArea({ label: r.label, lat: r.lat, lon: r.lon }));
                        }}
                      >
                        {r.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="bg-white rounded-lg shadow p-4">
              <h2 className="font-semibold text-lg text-gray-800 mb-1 flex items-center">
                <Cloud size={18} className="mr-1 text-gray-500" /> Account
              </h2>
              {sync.auth ? (
                <>
                  <p className="text-sm text-gray-600 mb-3">
                    Signed in as <span className="font-medium text-gray-800">{sync.auth.email}</span>
                    {sync.profile && (
                      <span className="text-gray-500"> · {TIER_LABEL[sync.profile.tier] ?? sync.profile.tier} · {sync.profile.counts.reports} uploads</span>
                    )}
                  </p>
                  <label htmlFor="displayName" className="block text-sm font-medium text-gray-700 mb-1">Display name</label>
                  <div className="flex gap-2 mb-3">
                    <input id="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputClass} placeholder="Shown next to your prices" />
                    <button
                      onClick={() => void run(() => sync.updateDisplayName(displayName))}
                      disabled={busy || !displayName.trim() || displayName.trim() === (sync.profile?.displayName ?? '')}
                      className="px-4 rounded-lg bg-blue-500 text-white disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                  <button onClick={() => void run(() => sync.signOut())} disabled={busy} className={`${secondaryButton} flex items-center justify-center`}>
                    <LogOut size={16} className="mr-1" /> Sign out
                  </button>
                </>
              ) : (
                <>
                  <p className="text-sm text-gray-600 mb-3">
                    You can see community prices without an account. Sign in with your email to share your own scans.
                  </p>
                  {!codeSent ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(async () => {
                          await sync.requestCode(email);
                          setCodeSent(true);
                        });
                      }}
                      className="space-y-2"
                    >
                      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className={inputClass} required />
                      <button type="submit" disabled={busy || !email.includes('@')} className={primaryButton}>Send sign-in code</button>
                    </form>
                  ) : (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(async () => {
                          await sync.verifyCode(email, code);
                          setCode('');
                          setCodeSent(false);
                        });
                      }}
                      className="space-y-2"
                    >
                      <p className="text-sm text-gray-600">We sent a 6-digit code to {email}.</p>
                      <input
                        inputMode="numeric"
                        pattern="\d{6}"
                        maxLength={6}
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                        placeholder="123456"
                        className={`${inputClass} tracking-widest text-center text-lg`}
                        autoFocus
                      />
                      <button type="submit" disabled={busy || code.length !== 6} className={primaryButton}>Verify</button>
                      <button type="button" onClick={() => { setCodeSent(false); setCode(''); }} className="w-full text-sm text-gray-500">Use a different email</button>
                    </form>
                  )}
                </>
              )}
              {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
            </section>

            {sync.auth && sync.profile?.entitlement.enforced && (
              <section className="bg-white rounded-lg shadow p-4">
                <h2 className="font-semibold text-lg text-gray-800 mb-1">Membership</h2>
                {sync.profile.entitlement.level === 'subscriber' ? (
                  <p className="text-sm text-gray-600">You're subscribed -- every price is unlocked.</p>
                ) : (
                  <>
                    <p className="text-sm text-gray-600 mb-2">
                      {sync.profile.entitlement.credits.earned} of {sync.profile.entitlement.credits.needed} credits this month.
                      Earn a credit for each verified, non-redundant price you share, or subscribe to unlock everything now.
                    </p>
                    <button onClick={() => void run(async () => { window.location.href = await sync.checkoutSubscription(); })} disabled={busy} className={primaryButton}>
                      Subscribe
                    </button>
                  </>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
};

export default SyncSettingsScreen;
