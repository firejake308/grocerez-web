import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { GroceryItem } from './PriceData';
import PriceData from './PriceData';

const units = [
  'each', 'pack', 'bag', 'box', 'can', 'bottle', 'jar', 'loaf',
  'oz', 'lbs', 'g', 'kg', 'ml', 'L', 'gal'
];

const AddItemScreen = ({ onBack, onSave, priceData }: { onBack: VoidFunction; onSave: (item: GroceryItem) => void; priceData: PriceData[] }) => {
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

  const handleSearch = (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = name.trim().toLowerCase();
    if (!q) return setSearchResults([]);
    const matches = priceData ?? [];
    const filtered = matches.filter(it => it.itemName && it.itemName.toLowerCase().includes(q));
    filtered.sort((a, b) => parsePrice(a.price) - parsePrice(b.price));
    setSelectedIndex(filtered.length ? 0 : null);
    setSearchResults(filtered);
  };

  const handleAddSelected = () => {
    if (!searchResults || selectedIndex === null) return;
    const chosen = searchResults[selectedIndex];
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

      <main className="flex-1 p-4">
        <form onSubmit={(e) => { e.preventDefault(); handleSearch(); }} className="space-y-4 bg-white rounded-lg shadow-md p-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Item name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-gray-200 rounded-md p-2" placeholder="e.g., Bananas" />
          </div>

          <div className="flex space-x-2">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
              <input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} className="w-full border border-gray-200 rounded-md p-2" />
            </div>

            <div className="w-36">
              <label className="block text-sm font-medium text-gray-700 mb-1">Unit</label>
              <select value={unit} onChange={(e) => setUnit(e.target.value)} className="w-full border border-gray-200 rounded-md p-2">
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
        {searchResults && (
          <div className="mt-4 bg-white p-2 rounded-md shadow-sm">
            {searchResults.length === 0 ? (
              <div className="p-4 text-gray-500">No matches found</div>
            ) : (
              <div className="space-y-2">
                {searchResults.map((r, idx) => (
                  <label key={idx} className="flex items-center justify-between p-2 border rounded-md">
                    <div className="flex items-center space-x-3">
                      <input type="radio" name="match" checked={selectedIndex === idx} onChange={() => setSelectedIndex(idx)} />
                      <div>
                        <div className="font-medium text-gray-800">{r.itemName}</div>
                        <div className="text-sm text-gray-500">{r.brand} • {r.store}</div>
                      </div>
                    </div>
                    <div className="text-sm font-semibold">{r.price}</div>
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
