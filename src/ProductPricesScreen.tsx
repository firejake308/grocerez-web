import { useEffect, useState } from 'react';
import { ArrowLeft, Flag, ThumbsUp } from 'lucide-react';
import type { SyncController } from './sync/useSync';
import { SignInRequiredError } from './sync/useSync';
import { createSyncApi, type FlagReason } from './sync/api';
import { SYNC_API_URL } from './sync/config';
import { localSyncStorage } from './sync/storage';
import type { ProductPricesResponse, SyncedPriceReport } from '../shared/types';

const formatCents = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

const TIER_LABEL: Record<string, string> = { new: 'new', restricted: 'new', established: 'established', trusted: 'trusted' };

const FLAG_REASONS: { value: FlagReason; label: string }[] = [
  { value: 'wrong_price', label: 'Price is wrong' },
  { value: 'expired', label: 'Sale has expired' },
  { value: 'wrong_item', label: "That's not this item" },
  { value: 'duplicate', label: 'Duplicate of another report' },
  { value: 'spam', label: 'Looks made up' },
  { value: 'other', label: 'Something else' },
];

/** Current price per store, plus full history for one product (plan section 10). */
const ProductPricesScreen = ({ productId, sync, onBack }: { productId: string; sync: SyncController; onBack: VoidFunction }) => {
  const [data, setData] = useState<ProductPricesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const token = sync.auth?.sessionToken ?? localSyncStorage.getDeviceToken();
      if (!token) throw new Error('Not connected to the sync server yet. Try again in a moment.');
      const api = createSyncApi(SYNC_API_URL);
      setData(await api.productPrices(token, productId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load price history.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <header className="bg-green-600 p-4 shadow-md flex items-center">
        <button onClick={onBack} className="p-2 text-white" aria-label="Back">
          <ArrowLeft size={24} />
        </button>
        <h1 className="text-xl font-semibold text-white ml-2 truncate">{data?.product.canonicalName ?? 'Price History'}</h1>
      </header>

      <main className="flex-1 p-4 overflow-auto space-y-4">
        {loading && <div className="text-center text-gray-500 py-8">Loading…</div>}
        {error && <div className="text-center text-red-600 py-8">{error}</div>}

        {data && (
          <>
            <section className="bg-white rounded-lg shadow p-4">
              <h2 className="font-semibold text-gray-800 mb-3">Current price by store</h2>
              {data.current.length === 0 ? (
                <p className="text-sm text-gray-500">No current prices near you yet.</p>
              ) : (
                <div className="space-y-3">
                  {data.current.map((c) => (
                    <div key={c.storeId} className={`p-2 rounded-md ${c.isStale ? 'opacity-60' : ''}`}>
                      <div className="flex justify-between items-baseline">
                        <div>
                          <div className="font-medium text-gray-800">{c.storeName}</div>
                          {c.storeAddress && <div className="text-xs text-gray-500">{c.storeAddress}</div>}
                        </div>
                        <div className="font-semibold text-gray-900">{formatCents(c.priceCents)}</div>
                      </div>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {(c.authorTier === 'new' || c.authorTier === 'restricted') && (
                          <span className="text-[10px] uppercase tracking-wide bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded-full">Unverified</span>
                        )}
                        {c.isStale && (
                          <span className="text-[10px] uppercase tracking-wide bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded-full">Stale ({c.observedDate})</span>
                        )}
                      </div>
                      {c.contested && (
                        <div className="text-xs text-amber-700 mt-1">
                          Reported {formatCents(c.contested.priceCents)} on {c.contested.observedDate} (unverified)
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="bg-white rounded-lg shadow p-4">
              <h2 className="font-semibold text-gray-800 mb-3">History ({data.history.length})</h2>
              <div className="space-y-3">
                {data.history.map((h) => (
                  <HistoryRow key={h.id} report={h} sync={sync} onChanged={load} />
                ))}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
};

const HistoryRow = ({ report, sync, onChanged }: { report: SyncedPriceReport; sync: SyncController; onChanged: () => void }) => {
  const [busy, setBusy] = useState(false);
  const [flagOpen, setFlagOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMine = report.userId === sync.auth?.userId;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setFlagOpen(false);
      onChanged();
    } catch (err) {
      setError(err instanceof SignInRequiredError ? 'Sign in to do that.' : err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`p-2 border-b border-gray-100 ${report.isStale || report.status !== 'active' ? 'opacity-60' : ''}`}>
      <div className="flex justify-between">
        <div>
          <div className="text-sm text-gray-800">{report.storeName} · {TIER_LABEL[report.authorTier] ?? report.authorTier}</div>
          <div className="text-xs text-gray-500">{report.observedDate}{report.status !== 'active' ? ` · ${report.status}` : ''}</div>
        </div>
        <div className="font-medium text-gray-900">{formatCents(report.priceCents)}</div>
      </div>
      {report.reviewReason === 'price_outlier' && (
        <span className="inline-block mt-1 text-[10px] uppercase tracking-wide bg-orange-100 text-orange-800 px-1.5 py-0.5 rounded-full">Unusual price</span>
      )}
      {!isMine && (
        <div className="mt-1">
          <div className="flex items-center gap-3 text-xs">
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => (report.myVote === 'confirm' ? sync.removeVote(report.id) : sync.confirmReport(report.id)))}
              className={`flex items-center gap-1 disabled:opacity-50 ${report.myVote === 'confirm' ? 'text-green-700 font-medium' : 'text-gray-500 hover:text-green-700'}`}
            >
              <ThumbsUp size={13} /> {report.confirmCount ? `Confirmed (${report.confirmCount})` : 'I saw this too'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => (report.myVote === 'flag' ? run(() => sync.removeVote(report.id)) : setFlagOpen((o) => !o))}
              className={`flex items-center gap-1 disabled:opacity-50 ${report.myVote === 'flag' ? 'text-red-700 font-medium' : 'text-gray-500 hover:text-red-700'}`}
            >
              <Flag size={13} /> {report.myVote === 'flag' ? 'Flagged' : 'Flag'}
            </button>
          </div>
          {flagOpen && (
            <div className="mt-1 flex flex-wrap gap-1">
              {FLAG_REASONS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => sync.flagReport(report.id, r.value))}
                  className="text-xs border border-gray-300 rounded-full px-2 py-0.5 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}
          {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
        </div>
      )}
    </div>
  );
};

export default ProductPricesScreen;
