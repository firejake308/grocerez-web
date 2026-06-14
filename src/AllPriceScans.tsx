import { ArrowLeft, Edit, Trash2 } from 'lucide-react';
import PriceData from './PriceData';

interface AllPriceScansProps {
  priceData: PriceData[];
  onBack: VoidFunction;
  onEdit: (index: number) => void;
  onDelete: (index: number) => void;
}

const AllPriceScans = ({ priceData, onBack, onEdit, onDelete }: AllPriceScansProps) => {
  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <header className="bg-green-600 p-4 shadow-md flex items-center">
        <button onClick={onBack} className="p-2">
          <ArrowLeft size={24} />
        </button>
        <h1 className="text-2xl font-bold text-white text-center flex-1">All Price Scans</h1>
      </header>

      <main className="flex-1 p-4 overflow-auto">
        <div className="space-y-4">
          {priceData.map((item, index) => (
            <div key={index} className="bg-white rounded-lg shadow-md p-4">
              <div className="flex justify-between items-start mb-2">
                <div>
                  <span className="font-medium text-gray-700 block">{item.itemName}</span>
                  <span className="text-sm text-gray-500 block">{item.brand}</span>
                  <span className="font-bold text-gray-900">{item.price.charAt(0) === '$' ? item.price : '$' + item.price}</span>
                </div>
                <div className="flex space-x-2">
                  <button 
                    onClick={() => onEdit(index)}
                    className="p-2 text-blue-600 hover:bg-blue-50 rounded-full"
                  >
                    <Edit size={20} />
                  </button>
                  <button 
                    onClick={() => onDelete(index)}
                    className="p-2 text-red-600 hover:bg-red-50 rounded-full"
                  >
                    <Trash2 size={20} />
                  </button>
                </div>
              </div>
              <div className="text-gray-600">
                <span className="block">{item.tags.join(', ')}</span>
                <span className="text-sm text-gray-500">{item.store}</span>
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
};

export default AllPriceScans;