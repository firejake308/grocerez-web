import { useMemo, useState } from 'react';
import { ChevronLeft, Flag, ThumbsUp } from 'lucide-react';
import { GroceryItem } from './PriceData';
import PriceData from './PriceData';
import { filterBySearchQuery, tokenize } from './searchUtils';
import PriceBadges from './PriceBadges';
import type { SyncController } from './sync/useSync';
import { SignInRequiredError } from './sync/useSync';
import type { FlagReason } from './sync/api';

const units = [
  'each', 'pack', 'bag', 'box', 'can', 'bottle', 'jar', 'loaf',
  'oz', 'lbs', 'g', 'kg', 'ml', 'L', 'gal'
];

const FLAG_REASONS: { value: FlagReason; label: string }[] = [
  { value: 'wrong_price', label: 'Price is wrong' },
  { value: 'expired', label: 'Sale has expired' },
  { value: 'wrong_item', label: "That's not this item" },
  { value: 'duplicate', label: 'Duplicate of another report' },
  { value: 'spam', label: 'Looks made up' },
  { value: 'other', label: 'Something else' },
];

/** Confirm/flag buttons for a community price report. Voting needs an account; own reports never show these. */
const VoteControls = ({ item, sync }: { item: PriceData; sync?: SyncController }) => {
  const [busy, setBusy] = useState(false);
  const [flagOpen, setFlagOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!sync || item.origin !== 'community' || item.userId === sync.auth?.userId) return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setFlagOpen(false);
    } catch (err) {
      setError(err instanceof SignInRequiredError ? 'Sign in (via the cloud button on Home) to do that.' : err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1" onClick={(e) => e.preventDefault()}>
      <div className="flex items-center gap-3 text-xs">
        <button
          type="button"
          disabled={busy}
          onClick={() => run(() => (item.myVote === 'confirm' ? sync.removeVote(item.id) : sync.confirmReport(item.id)))}
          className={`flex items-center gap-1 disabled:opacity-50 ${item.myVote === 'confirm' ? 'text-green-700 font-medium' : 'text-gray-500 hover:text-green-700'}`}
        >
          <ThumbsUp size={13} /> {item.confirmCount ? `Confirmed (${item.confirmCount})` : 'I saw this too'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => (item.myVote === 'flag' ? run(() => sync.removeVote(item.id)) : setFlagOpen((o) => !o))}
          className={`flex items-center gap-1 disabled:opacity-50 ${item.myVote === 'flag' ? 'text-red-700 font-medium' : 'text-gray-500 hover:text-red-700'}`}
        >
          <Flag size={13} /> {item.myVote === 'flag' ? 'Flagged' : 'Flag'}
        </button>
      </div>
      {flagOpen && (
        <div className="mt-1 flex flex-wrap gap-1">
          {FLAG_REASONS.map((r) => (
            <button
              key={r.value}
              type="button"
              disabled={busy}
              onClick={() => run(() => sync.flagReport(item.id, r.value))}
              className="text-xs border border-gray-300 rounded-full px-2 py-0.5 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
      {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
    </div>
  );
};

const AddItemScreen = ({
  onBack,
  onSave,
  priceData,
  sync,
  onViewPriceHistory,
}: {
  onBack: VoidFunction;
  onSave: (item: GroceryItem) => void;
  priceData: PriceData[];
  sync?: SyncController;
  onViewPriceHistory?: (productId: string) => void;
}) => {
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState<number>(1);
  const [unit, setUnit] = useState<string>('each');

  const [searchResults, setSearchResults] = useState<PriceData[] | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const parsePrice = (p: string) => {
    if (!p) return Infinity;
    const cleaned = p.replace(/[^0-9.]/g, '');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : Infinity;
  };

  const formatRelativeDate = (dateStr: string) => {
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return dateStr;
    const today = new Date();
    const msPerDay = 24 * 60 * 60 * 1000;
    const days = Math.floor((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) / msPerDay);
    if (days <= 0) return 'today';
    if (days === 1) return '1 day ago';
    return `${days} days ago`;
  };

  const jaccard = (a: Set<string>, b: Set<string>) => {
    if (a.size === 0 && b.size === 0) return 1;
    let intersection = 0;
    a.forEach(t => { if (b.has(t)) intersection++; });
    return intersection / (a.size + b.size - intersection);
  };

  const itemKey = (it: PriceData) => tokenize(`${it.brand} ${it.itemName}`);

  const sameBrand = (a: PriceData, b: PriceData) => {
    const ba = a.brand.trim().toLowerCase();
    const bb = b.brand.trim().toLowerCase();
    return !ba || !bb || ba === bb;
  };

  const deduplicateByRecency = (items: PriceData[]): PriceData[] => {
    const groups: PriceData[][] = [];
    for (const item of items) {
      const key = itemKey(item);
      const group = groups.find(g =>
        g[0].store === item.store &&
        sameBrand(g[0], item) &&
        jaccard(itemKey(g[0]), key) >= 0.5
      );
      if (group) group.push(item);
      else groups.push([item]);
    }
    return groups.map(g =>
      g.reduce((best, cur) => (cur.date >= best.date ? cur : best))
    );
  };

  const handleSearch = (e?: React.FormEvent) => {
    e?.preventDefault();
    const matches = priceData ?? [];
    const filtered = filterBySearchQuery(matches, name);
    const deduped = deduplicateByRecency(filtered);
    deduped.sort((a, b) => parsePrice(a.price) - parsePrice(b.price));
    setSelectedIndex(deduped.length ? 0 : null);
    setSearchResults(deduped);
  };

  // searchResults is a snapshot taken at search time; re-derive the volatile fields
  // (vote counts, myVote, status) from the latest priceData so confirm/flag reflect instantly.
  const liveResults = useMemo(() => {
    if (!searchResults) return null;
    const byId = new Map(priceData.map((it) => [it.id, it]));
    return searchResults.map((r) => byId.get(r.id) ?? r);
  }, [searchResults, priceData]);

  const handleAddSelected = () => {
    if (!liveResults || selectedIndex === null) return;
    const chosen = liveResults[selectedIndex];
    const newItem: GroceryItem = {
      id: (crypto && typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : String(Date.now()),
      name: chosen.itemName || name.trim(),
      quantity: Number(quantity) || 1,
      unit: unit || 'each',
      checked: false
    };
    onSave(newItem);
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <header className="bg-white p-3 shadow-sm flex items-center">
        <button onClick={onBack} className="p-2 text-gray-700 hover:bg-gray-100 rounded-md">
          <ChevronLeft />
        </button>
        <h1 className="text-lg font-semibold ml-2">Add Item</h1>
      </header>

      <main className="flex-1 p-4 overflow-y-auto">
        <form onSubmit={(e) => { e.preventDefault(); handleSearch(); }} className="space-y-4 bg-white rounded-lg shadow-md p-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Item name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-gray-200 rounded-md p-2 bg-white text-gray-900" placeholder="e.g., Bananas" />
          </div>

          <div className="flex space-x-2">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
              <input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} className="w-full border border-gray-200 rounded-md p-2 bg-white text-gray-900" />
            </div>

            <div className="w-36">
              <label className="block text-sm font-medium text-gray-700 mb-1">Unit</label>
              <select value={unit} onChange={(e) => setUnit(e.target.value)} className="w-full border border-gray-200 rounded-md p-2 bg-white text-gray-900">
                {units.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          </div>

          <div className="pt-2">
            <button type="button" onClick={() => handleSearch()} disabled={!name.trim()} className="w-full bg-blue-500 text-white p-3 rounded-md disabled:opacity-50">
              Search
            </button>
          </div>
        </form>

        {/* Search results */}
        {liveResults && (
          <div className="mt-4 bg-white p-2 rounded-md shadow-sm">
            {liveResults.length === 0 ? (
              <div className="p-4 text-gray-500">No matches found</div>
            ) : (
              <div className="space-y-2">
                {liveResults.map((r, idx) => (
                  <label key={idx} className="flex items-start justify-between p-2 border rounded-md">
                    <div className="flex items-start space-x-3">
                      <input type="radio" name="match" checked={selectedIndex === idx} onChange={() => setSelectedIndex(idx)} className="mt-1" />
                      <div>
                        <div className="font-medium text-gray-800 flex items-center gap-2">
                          {r.itemName}
                          {r.origin === 'community' && (
                            <span className="text-[10px] uppercase tracking-wide bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded-full">
                              Community{r.authorTier && r.authorTier !== 'new' ? ` · ${r.authorTier}` : ''}
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-gray-500">{r.brand} • {r.store}</div>
                        {(r.quantity || r.quantity_units) && (
                          <div className="text-xs text-gray-500">{r.quantity} {r.quantity_units}</div>
                        )}
                        {r.date && <div className="text-xs text-gray-400">Updated {formatRelativeDate(r.date)}</div>}
                        <PriceBadges item={r} />
                        <VoteControls item={r} sync={sync} />
                        {r.productId && onViewPriceHistory && (
                          <button
                            type="button"
                            onClick={(e) => { e.preventDefault(); onViewPriceHistory(r.productId!); }}
                            className="text-xs text-blue-600 hover:underline mt-1"
                          >
                            View price history
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="text-sm font-semibold text-gray-800">{r.price.startsWith('$') ? r.price : `$${r.price}`}</div>
                  </label>
                ))}
                <div className="pt-3">
                  <button onClick={handleAddSelected} disabled={selectedIndex === null} className="w-full bg-green-500 text-white p-3 rounded-md disabled:opacity-50">Add to List</button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
};

export default AddItemScreen;
