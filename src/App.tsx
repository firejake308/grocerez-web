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

type Screen = 'home' | 'scanner' | 'addItem' | 'allPrices' | 'edit';

const push = (screen: Screen, state?: Record<string, unknown>) => {
  window.history.pushState({ screen, ...state }, '');
};

const App = () => {
  const stripImagesFromPriceData = (data: PriceData[]): Omit<PriceData, 'priceImage' | 'productImage'>[] => {
    return data.map(({ priceImage: _, productImage: __, ...rest }) => rest);
  };

  const [currentScreen, setCurrentScreen] = useState<Screen>('home');
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

  // Seed the initial history entry so there's always something to pop back to
  useEffect(() => {
    window.history.replaceState({ screen: 'home' }, '');

    const onPopState = (e: PopStateEvent) => {
      const screen: Screen = e.state?.screen ?? 'home';
      setCurrentScreen(screen);
      if (screen === 'edit') {
        setEditingIndex(e.state?.editingIndex ?? -1);
      }
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const dataWithoutImages = stripImagesFromPriceData(priceData);
    localStorage.setItem('priceData', JSON.stringify(dataWithoutImages));
  }, [priceData]);

  useEffect(() => {
    localStorage.setItem('groceryItems', JSON.stringify(groceryItems));
  }, [groceryItems]);

  const navigateTo = (screen: Screen, state?: Record<string, unknown>) => {
    push(screen, state);
    setCurrentScreen(screen);
  };

  const handleSavePriceData = (data: PriceData) => {
    const normalizedData = normalizePriceData(data);
    setPriceData((currentPriceData) => [...currentPriceData, normalizedData]);
    console.log("Price data saved:", normalizedData);
    // Replace history back to home rather than pushing, so back from home exits the app
    window.history.go(-(window.history.length - 1));
    setCurrentScreen('home');
  };

  const handleEditPriceData = (index: number) => {
    setEditingIndex(index);
    navigateTo('edit', { editingIndex: index });
  };

  const handleSaveEdit = (updatedItem: PriceData) => {
    const newPriceData = [...priceData];
    newPriceData[editingIndex] = updatedItem;
    setPriceData(newPriceData);
    // Go back to allPrices without adding a new entry
    window.history.back();
  };

  const handleDeletePriceData = (index: number) => {
    const newPriceData = priceData.filter((_, i) => i !== index);
    setPriceData(newPriceData);
  };

  const handleAddGroceryItem = (item: GroceryItem) => {
    setGroceryItems([...groceryItems, item]);
    window.history.back();
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
          onScan={() => navigateTo('scanner')}
          priceData={priceData}
          onShowAllPrices={() => navigateTo('allPrices')}
          groceryItems={groceryItems}
          onAddItem={() => navigateTo('addItem')}
          onToggleItem={handleToggleGroceryItem}
          onDeleteItem={handleDeleteGroceryItem}
        />
      )}

      {currentScreen === 'addItem' && (
        <AddItemScreen
          onBack={() => window.history.back()}
          onSave={handleAddGroceryItem}
          priceData={priceData}
        />
      )}

      {currentScreen === 'scanner' && (
        <PriceScanner
          onBack={() => window.history.back()}
          onSave={handleSavePriceData}
        />
      )}

      {currentScreen === 'allPrices' && (
        <AllPriceScans
          priceData={priceData}
          onBack={() => window.history.back()}
          onEdit={handleEditPriceData}
          onDelete={handleDeletePriceData}
        />
      )}

      {currentScreen === 'edit' && editingIndex !== -1 && (
        <EditPriceScan
          item={priceData[editingIndex]}
          onBack={() => window.history.back()}
          onSave={handleSaveEdit}
        />
      )}
    </div>
  );
};

export default App;
