import React, { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import PriceData from './PriceData';

interface EditPriceScanProps {
  item: PriceData;
  onBack: () => void;
  onSave: (updatedItem: PriceData) => void;
}

const EditPriceScan: React.FC<EditPriceScanProps> = ({ item, onBack, onSave }) => {
  const [itemName, setItemName] = useState(item.itemName);
  const [price, setPrice] = useState(item.price);
  const [tags, setTags] = useState(item.tags.join(', '));
  const [store, setStore] = useState(item.store);
  const [brand, setBrand] = useState(item.brand);
  const [quantity, setQuantity] = useState(item.quantity);
  const [quantity_units, setQuantityUnits] = useState(item.quantity_units);

  const handleSave = () => {
    const updatedItem: PriceData = {
      ...item,
      itemName,
      brand,
      price: price.startsWith('$') ? price : `$${price}`,
      tags: tags.split(',').map(tag => tag.trim()).filter(tag => tag !== ''),
      store,
      quantity,
      quantity_units
    };
    onSave(updatedItem);
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <header className="bg-green-600 p-4 shadow-md flex items-center">
        <button onClick={onBack} className="p-2">
          <ArrowLeft size={24} />
        </button>
        <h1 className="text-xl font-semibold text-white ml-2">Edit Price Scan</h1>
      </header>

      <div className="flex-1 p-4 overflow-auto">
        <div className="bg-white rounded-lg shadow p-4 mb-4">
          <h2 className="font-semibold text-lg mb-3">Price Information</h2>
          <div className="space-y-4">
            <div>
              <label htmlFor="itemName" className="block text-sm font-medium text-gray-700 mb-1">
                Item Name
              </label>
              <input
                type="text"
                id="itemName"
                value={itemName}
                onChange={(e) => setItemName(e.target.value)}
                className="block w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>

            <div>
              <label htmlFor="price" className="block text-sm font-medium text-gray-700 mb-1">
                Price
              </label>
              <input
                type="text"
                id="price"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="block w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>

            <div>
              <label htmlFor="tags" className="block text-sm font-medium text-gray-700 mb-1">
                Tags (comma separated)
              </label>
              <input
                type="text"
                id="tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                className="block w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>

            <div>
              <label htmlFor="store" className="block text-sm font-medium text-gray-700 mb-1">
                Store
              </label>
              <input
                type="text"
                id="store"
                value={store}
                onChange={(e) => setStore(e.target.value)}
                className="block w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>

            <div>
              <label htmlFor="brand" className="block text-sm font-medium text-gray-700 mb-1">
                Brand
              </label>
              <input
                type="text"
                id="brand"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                className="block w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>

            <div className="flex gap-4">
              <div className="flex-1">
                <label htmlFor="quantity" className="block text-sm font-medium text-gray-700 mb-1">
                  Quantity
                </label>
                <input
                  type="number"
                  id="quantity"
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-lg"
                  min="0"
                  step="0.01"
                />
              </div>
              <div className="flex-1">
                <label htmlFor="quantity_units" className="block text-sm font-medium text-gray-700 mb-1">
                  Units
                </label>
                <input
                  type="text"
                  id="quantity_units"
                  value={quantity_units}
                  onChange={(e) => setQuantityUnits(e.target.value)}
                  placeholder="e.g., lbs, oz, each"
                  className="block w-full px-3 py-2 border border-gray-300 rounded-lg"
                />
              </div>
            </div>

          </div>
        </div>
      </div>

      <div className="p-4 border-t border-gray-200">
        <button
          onClick={handleSave}
          className="w-full p-4 rounded-lg font-medium text-white bg-green-500 hover:bg-green-600"
        >
          Save Changes
        </button>
      </div>
    </div>
  );
};

export default EditPriceScan;