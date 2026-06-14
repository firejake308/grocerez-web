import { useState, useEffect } from 'react';
import HomeScreen from './HomeScreen';
import PriceScanner from './PriceScanner';
import AllPriceScans from './AllPriceScans';
import EditPriceScan from './EditPriceScan';
import PriceData, { GroceryItem } from './PriceData';
import AddItemScreen from './AddItemScreen';

type PartialPriceData = Partial<Omit<PriceData, 'price' | 'tags' | 'quantity'>> & {
  price?: string | number;
  tags?: string[] | string;
  quantity?: number | string;
};

const normalizePriceData = (item: PartialPriceData): PriceData => {
  const normalizedTags = Array.isArray(item.tags)
    ? item.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean)
    : typeof item.tags === 'string'
      ? item.tags.split(',').map((tag: string) => tag.trim()).filter(Boolean)
      : [];

  const normalizedQuantity = typeof item.quantity === 'number'
    ? item.quantity
    : Number(item.quantity);

  return {
    price: typeof item.price === 'string' ? item.price : String(item.price ?? ''),
    store: typeof item.store === 'string' ? item.store : '',
    date: typeof item.date === 'string' ? item.date : '',
    priceImage: typeof item.priceImage === 'string' ? item.priceImage : null,
    productImage: typeof item.productImage === 'string' ? item.productImage : null,
    itemName: typeof item.itemName === 'string' ? item.itemName : '',
    brand: typeof item.brand === 'string' ? item.brand : '',
    tags: normalizedTags,
    quantity: Number.isFinite(normalizedQuantity) ? normalizedQuantity : 1,
    quantity_units: typeof item.quantity_units === 'string' ? item.quantity_units : '',
    latitude: typeof item.latitude === 'number' ? item.latitude : null,
    longitude: typeof item.longitude === 'number' ? item.longitude : null,
  };
};

const App = () => {
  const stripImagesFromPriceData = (data: PriceData[]): Omit<PriceData, 'priceImage' | 'productImage'>[] => {
    return data.map(({ priceImage: _, productImage: __, ...rest }) => rest);
  };

  const [currentScreen, setCurrentScreen] = useState('home');
  const [priceData, setPriceData] = useState<PriceData[]>(() => {
    const savedData = localStorage.getItem('priceData');
    if (!savedData) {
      return [];
    }

    try {
      const parsedData = JSON.parse(savedData);
      return Array.isArray(parsedData) ? parsedData.map(normalizePriceData) : [];
    } catch (error) {
      console.error('Failed to parse saved price data:', error);
      return [];
    }
  });
  const [editingIndex, setEditingIndex] = useState<number>(-1);
  const [groceryItems, setGroceryItems] = useState<GroceryItem[]>(() => {
    const saved = localStorage.getItem('groceryItems');
    return saved ? JSON.parse(saved) : [];
  });

  useEffect(() => {
    const dataWithoutImages = stripImagesFromPriceData(priceData);
    localStorage.setItem('priceData', JSON.stringify(dataWithoutImages));
  }, [priceData]);

  useEffect(() => {
    localStorage.setItem('groceryItems', JSON.stringify(groceryItems));
  }, [groceryItems]);

  const navigateToScanner = () => {
    setCurrentScreen('scanner');
  };

  const navigateToAddItem = () => {
    setCurrentScreen('addItem');
  };

  const navigateToHome = () => {
    setCurrentScreen('home');
  };

  const handleSavePriceData = (data: PriceData) => {
    const normalizedData = normalizePriceData(data);
    setPriceData((currentPriceData) => [...currentPriceData, normalizedData]);
    console.log("Price data saved:", normalizedData);
    setCurrentScreen('home');
  };

  const handleEditPriceData = (index: number) => {
    setEditingIndex(index);
    setCurrentScreen('edit');
  };

  const handleSaveEdit = (updatedItem: PriceData) => {
    const newPriceData = [...priceData];
    newPriceData[editingIndex] = updatedItem;
    setPriceData(newPriceData);
    setCurrentScreen('allPrices');
  };

  const handleDeletePriceData = (index: number) => {
    const newPriceData = priceData.filter((_, i) => i !== index);
    setPriceData(newPriceData);
  };

  const handleAddGroceryItem = (item: GroceryItem) => {
    setGroceryItems([...groceryItems, item]);
    setCurrentScreen('home');
  };

  const handleToggleGroceryItem = (id: string) => {
    setGroceryItems(groceryItems.map(it => it.id === id ? { ...it, checked: !it.checked } : it));
  };

  const handleDeleteGroceryItem = (id: string) => {
    setGroceryItems(groceryItems.filter(it => it.id !== id));
  };

  return (
    <div className="h-screen">
      {currentScreen === 'home' && (
        <HomeScreen 
          onScan={navigateToScanner} 
          priceData={priceData}
          onShowAllPrices={() => setCurrentScreen('allPrices')}
          groceryItems={groceryItems}
          onAddItem={navigateToAddItem}
          onToggleItem={handleToggleGroceryItem}
          onDeleteItem={handleDeleteGroceryItem}
        />
      )}

      {currentScreen === 'addItem' && (
        <AddItemScreen
          onBack={navigateToHome}
          onSave={handleAddGroceryItem}
          priceData={priceData}
        />
      )}
      
      {currentScreen === 'scanner' && (
        <PriceScanner 
          onBack={navigateToHome}
          onSave={handleSavePriceData}
        />
      )}

      {currentScreen === 'allPrices' && (
        <AllPriceScans
          priceData={priceData}
          onBack={() => setCurrentScreen('home')}
          onEdit={handleEditPriceData}
          onDelete={handleDeletePriceData}
        />
      )}

      {currentScreen === 'edit' && editingIndex !== -1 && (
        <EditPriceScan
          item={priceData[editingIndex]}
          onBack={() => setCurrentScreen('allPrices')}
          onSave={handleSaveEdit}
        />
      )}
    </div>
  );
};

export default App;