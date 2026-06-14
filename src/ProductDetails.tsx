import { ArrowLeft, Camera, MapPin, ShoppingBag } from "lucide-react";

interface ProductDetailsProps {
  scannedPrice: string | null;
  priceImage: string | null;
  productImage: string | null;
  isLocating: boolean; 
  storeLocation: string; 
  setStoreLocation: (loc: string) => void; 
  setScanStep: (step: 'price' | 'product' | 'processing' | 'details') => void; 
  retakePhoto: VoidFunction; 
  saveAndContinue: VoidFunction;
  itemName: string;
  setItemName: (name: string) => void;
  tags: string;
  setTags: (tags: string) => void;
  quantity: number;
  setQuantity: (quantity: number) => void;
  quantity_units: string;
  setQuantityUnits: (units: string) => void;
  brand: string;
  setBrand: (brand: string) => void;
}

const ProductDetails: React.FC<ProductDetailsProps> = ({ 
  scannedPrice, 
  priceImage, 
  productImage, 
  isLocating, 
  storeLocation, 
  setStoreLocation, 
  setScanStep, 
  retakePhoto, 
  saveAndContinue,
  itemName,
  setItemName,
  tags,
  setTags,
  quantity,
  setQuantity,
  quantity_units,
  setQuantityUnits,
  brand,
  setBrand
}) => {
  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-green-600 p-4 flex items-center">
        <button onClick={() => setScanStep('product')} className="text-white p-2">
          <ArrowLeft size={24} />
        </button>
        <h1 className="text-xl font-semibold text-white ml-2">Price Details</h1>
      </div>

      {/* Content */}
      <div className="flex-1 p-4 overflow-auto">
        <div className="bg-white rounded-lg shadow p-4 mb-4">
          <h2 className="font-semibold text-lg mb-3">Price Information</h2>
          <div className="flex justify-between items-center mb-4">
            <div className="flex-1 mr-4">
              <p className="text-gray-600">Detected Price</p>
              <p className="text-2xl font-bold text-green-600">{scannedPrice}</p>
            </div>
            <div className="h-16 w-16 bg-gray-200 rounded overflow-hidden">
              {priceImage && (
                <img src={priceImage} alt="Price tag" className="h-full w-full object-cover" />
              )}
            </div>
          </div>
          <div className="space-y-3">
            <div>
              <label htmlFor="itemName" className="block text-sm font-medium text-gray-700 mb-1">
                Item Name
              </label>
              <input
                type="text"
                id="itemName"
                value={itemName}
                onChange={(e) => setItemName(e.target.value)}
                placeholder="Enter item name"
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
                placeholder="Enter brand name"
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
                placeholder="e.g., grocery, dairy, organic"
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

        <div className="bg-white rounded-lg shadow p-4 mb-4">
          <h2 className="font-semibold text-lg mb-3">Product Image</h2>
          <div className="w-full aspect-square bg-gray-200 rounded-lg overflow-hidden mb-3">
            {productImage ? (
              <img src={productImage} alt="Product" className="h-full w-full object-cover" />
            ) : (
              <div className="h-full flex items-center justify-center">
                <ShoppingBag size={48} className="text-gray-400" />
              </div>
            )}
          </div>
          <button
            onClick={retakePhoto}
            className="w-full py-2 border border-gray-300 rounded-lg text-white bg-gray-700 flex items-center justify-center"
          >
            <Camera size={18} className="mr-2" />
            Retake Photo
          </button>
        </div>

        <div className="bg-white rounded-lg shadow p-4 mb-4">
          <h2 className="font-semibold text-lg mb-3 text-gray-700">Store Location</h2>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <MapPin size={18} className="text-gray-500" />
            </div>
            <input
              type="text"
              value={storeLocation}
              onChange={(e) => setStoreLocation(e.target.value)}
              placeholder={isLocating ? "Detecting location..." : "Enter store name"}
              className="block w-full pl-10 pr-3 py-3 border border-gray-300 rounded-lg"
              disabled={isLocating}
            />
          </div>
          {isLocating && (
            <div className="mt-2 text-sm text-gray-500 flex items-center">
              <div className="animate-spin h-4 w-4 mr-2 border-t-2 border-b-2 border-gray-500 rounded-full"></div>
              Getting your location...
            </div>
          )}
        </div>
      </div>

      {/* Done Button */}
      <div className="p-4 border-t border-gray-200">
        <button
          onClick={saveAndContinue}
          disabled={!storeLocation}
          className={`w-full p-4 rounded-lg font-medium text-white ${storeLocation ? 'bg-green-500' : 'bg-gray-400'}`}
        >
          Done
        </button>
      </div>
    </div>
  );
}

export default ProductDetails;