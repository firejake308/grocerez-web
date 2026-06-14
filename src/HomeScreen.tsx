import { Plus, Camera, Trash2 } from 'lucide-react';
import PriceData, { GroceryItem } from './PriceData';

const HomeScreen = ({ 
  onScan, 
  priceData,
  onShowAllPrices,
  groceryItems,
  onAddItem,
  onToggleItem,
  onDeleteItem
}: {
  onScan: VoidFunction;
  priceData: PriceData[];
  onShowAllPrices: VoidFunction;
  groceryItems: GroceryItem[];
  onAddItem: VoidFunction;
  onToggleItem: (id: string) => void;
  onDeleteItem: (id: string) => void;
}) => {

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* App Header */}
      <header className="bg-green-600 p-4 shadow-md">
        <h1 className="text-2xl font-bold text-white text-center">GrocerEZ</h1>
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

        {/* Price Data Preview (optional) */}
        <div className="bg-white rounded-lg shadow-md p-4 mb-4">
          <h2 className="text-xl font-semibold mb-2 text-gray-800">Recent Price Scans</h2>
          {!priceData ? (
            <p className="text-gray-500 text-center py-2">Loading price data...</p>
          ) : priceData.length === 0 ? (
            <p className="text-gray-500 text-center py-2">No price scans yet</p>
          ) : (
            <div className="space-y-2">
              {priceData.slice(-3).map((item, index) => (
              <div key={index} className="p-2 border-b border-gray-100 flex flex-col">
                <div className="flex justify-between">
                  <span className="font-medium text-gray-700">{item.itemName}</span>
                  <span className="font-bold text-gray-900">{item.price.charAt(0) === '$' ? item.price : '$' + item.price}</span>
                </div>
                <div className="text-gray-600">
                  <span className="text-sm text-gray-500">{item.store}</span>
                </div>
              </div>
              ))}
              <button
                onClick={onShowAllPrices}
                className="w-full mt-4 py-2 px-4 text-sm text-green-600 hover:text-green-700 font-medium flex items-center justify-center border border-green-600 rounded-lg hover:bg-green-50 transition-colors"
              >
                Show All Price Scans
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Action Buttons */}
      <div className="p-4 space-y-3">
        <button 
          onClick={onAddItem}
          className="flex items-center justify-center w-full bg-blue-500 text-white p-4 rounded-lg shadow-md hover:bg-blue-600 transition-colors"
        >
          <Plus size={24} className="mr-2" />
          <span className="text-lg font-medium">Add New Item</span>
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