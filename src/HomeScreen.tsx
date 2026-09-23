import { useRef } from 'react';
import { Search, Camera, Trash2, Download, Upload, Cloud, CloudOff, Sparkles } from 'lucide-react';
import PriceData, { GroceryItem } from './PriceData';

const HomeScreen = ({
  onScan,
  priceData,
  discoverItems,
  onShowAllPrices,
  groceryItems,
  onAddItem,
  onToggleItem,
  onDeleteItem,
  onExportData,
  onImportData,
  syncEnabled,
  syncSignedIn,
  onOpenSync
}: {
  onScan: VoidFunction;
  priceData: PriceData[];
  discoverItems: PriceData[];
  onShowAllPrices: VoidFunction;
  groceryItems: GroceryItem[];
  onAddItem: VoidFunction;
  onToggleItem: (id: string) => void;
  onDeleteItem: (id: string) => void;
  onExportData: VoidFunction;
  onImportData: (file: File) => void;
  syncEnabled: boolean;
  syncSignedIn: boolean;
  onOpenSync: VoidFunction;
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onImportData(file);
    }
    e.target.value = '';
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* App Header */}
      <header className="bg-green-600 p-4 shadow-md flex items-center">
        <div className="flex-1 flex items-center space-x-1">
          <button
            onClick={onExportData}
            title="Export backup"
            aria-label="Export backup"
            className="text-white p-1.5 rounded hover:bg-green-700"
          >
            <Download size={20} />
          </button>
          <button
            onClick={handleImportClick}
            title="Import backup"
            aria-label="Import backup"
            className="text-white p-1.5 rounded hover:bg-green-700"
          >
            <Upload size={20} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
        <h1 className="text-2xl font-bold text-white text-center flex-1">GrocerEZ</h1>
        <div className="flex-1 flex justify-end">
          {syncEnabled && (
            <button
              onClick={onOpenSync}
              title="Community prices"
              aria-label="Community prices"
              className="text-white p-1.5 rounded hover:bg-green-700"
            >
              {syncSignedIn ? <Cloud size={20} /> : <CloudOff size={20} />}
            </button>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 p-4 overflow-auto">
        {/* Grocery List Section */}
        <div className="bg-white rounded-lg shadow-md p-4 mb-4">
          <h2 className="text-xl font-semibold mb-2 text-gray-800">My Grocery List</h2>
          
          {groceryItems.length === 0 ? (
            <p className="text-gray-500 text-center py-6">Your grocery list is empty. Add items to get started!</p>
          ) : (
            <div className="space-y-2">
              {groceryItems.map((item) => (
                <div key={item.id} className="flex items-center justify-between p-2 border-b border-gray-100">
                  <div className="flex items-center space-x-3">
                    <input type="checkbox" checked={item.checked} onChange={() => onToggleItem(item.id)} className="w-4 h-4" />
                    <div>
                      <div className={`font-medium ${item.checked ? 'line-through text-gray-400' : 'text-gray-700'}`}>{item.name}</div>
                      <div className="text-sm text-gray-500">{item.quantity} {item.unit}</div>
                    </div>
                  </div>
                  <button onClick={() => onDeleteItem(item.id)} className="text-red-500 hover:text-red-600">
                    <Trash2 size={18} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Discover: a taste of what's out there to search for, even before a location is set */}
        {discoverItems.length > 0 && (
          <div className="bg-white rounded-lg shadow-md p-4 mb-4">
            <h2 className="text-lg font-semibold mb-1 text-gray-800 flex items-center gap-1.5">
              <Sparkles size={18} className="text-green-600" />
              Prices People Are Sharing
            </h2>
            <p className="text-sm text-gray-500 mb-2">
              Set your home area in Community Prices to see what's near you instead of these random samples.
            </p>
            <div className="space-y-2">
              {discoverItems.slice(0, 6).map((item) => (
                <div key={item.id} className="p-2 border-b border-gray-100 flex flex-col">
                  <div className="flex justify-between">
                    <span className="font-medium text-gray-700">{item.itemName}</span>
                    <span className="font-bold text-gray-900">{item.price.charAt(0) === '$' ? item.price : '$' + item.price}</span>
                  </div>
                  <span className="text-sm text-gray-500">{item.store}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent Price Scans: de-emphasized, just a quiet link to the full history */}
        <button
          onClick={onShowAllPrices}
          className="w-full bg-white rounded-lg shadow-md p-3 mb-4 flex items-center justify-between text-sm text-gray-600 hover:bg-gray-50 transition-colors"
        >
          <span>Recent Price Scans</span>
          <span className="text-gray-400">
            {priceData && priceData.length > 0 ? `${priceData.length} saved →` : 'None yet →'}
          </span>
        </button>
      </main>

      {/* Action Buttons */}
      <div className="p-4 space-y-3">
        <button
          onClick={onAddItem}
          className="flex items-center justify-center w-full bg-blue-500 text-white p-4 rounded-lg shadow-md hover:bg-blue-600 transition-colors"
        >
          <Search size={24} className="mr-2" />
          <span className="text-lg font-medium">Search</span>
        </button>
        
        <button 
          onClick={onScan}
          className="flex items-center justify-center w-full bg-green-500 text-white p-4 rounded-lg shadow-md hover:bg-green-600 transition-colors"
        >
          <Camera size={24} className="mr-2" />
          <span className="text-lg font-medium">Scan Price</span>
        </button>
      </div>
    </div>
  );
};

export default HomeScreen;