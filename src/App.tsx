import { useState, useEffect } from 'react';
import HomeScreen from './HomeScreen';
import PriceScanner from './PriceScanner';
import AllPriceScans from './AllPriceScans';
import EditPriceScan from './EditPriceScan';
import PriceData, { GroceryItem } from './PriceData';
import AddItemScreen from './AddItemScreen';
import { normalizePriceData } from './normalizePriceData';

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
  const [editingId, setEditingId] = useState<string | null>(null);
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
        setEditingId(typeof e.state?.editingId === 'string' ? e.state.editingId : null);
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
    // Scanner only ever pushes one history entry, so a single back returns to home
    window.history.back();
  };

  const handleEditPriceData = (id: string) => {
    setEditingId(id);
    navigateTo('edit', { editingId: id });
  };

  const handleSaveEdit = (updatedItem: PriceData) => {
    const saved = normalizePriceData({ ...updatedItem, updatedAt: new Date().toISOString() });
    setPriceData((current) => current.map((item) => (item.id === saved.id ? saved : item)));
    // Go back to allPrices without adding a new entry
    window.history.back();
  };

  const handleDeletePriceData = (id: string) => {
    setPriceData((current) => current.filter((item) => item.id !== id));
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

  const handleExportData = () => {
    const exportPayload = {
      exportedAt: new Date().toISOString(),
      priceData: stripImagesFromPriceData(priceData),
      groceryItems,
    };
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `grocerez-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleImportData = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        // Backups made before sync have no ids and always append; backups
        // with ids skip reports this device already has.
        const knownIds = new Set(priceData.map((item) => item.id));
        const importedPriceData: PriceData[] = Array.isArray(parsed.priceData)
          ? parsed.priceData.map(normalizePriceData).filter((item: PriceData) => !knownIds.has(item.id))
          : [];

        const existingIds = new Set(groceryItems.map((item) => item.id));
        const importedGroceryItems: GroceryItem[] = Array.isArray(parsed.groceryItems)
          ? parsed.groceryItems.map((item: GroceryItem) => {
              if (!existingIds.has(item.id)) {
                existingIds.add(item.id);
                return item;
              }
              const newId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
                ? crypto.randomUUID()
                : `${item.id}-${Date.now()}`;
              existingIds.add(newId);
              return { ...item, id: newId };
            })
          : [];

        setPriceData((current) => [...current, ...importedPriceData]);
        setGroceryItems((current) => [...current, ...importedGroceryItems]);
        alert(`Imported ${importedPriceData.length} price scan(s) and ${importedGroceryItems.length} grocery item(s).`);
      } catch (error) {
        console.error('Failed to import data:', error);
        alert('That file could not be read as a GrocerEZ backup.');
      }
    };
    reader.readAsText(file);
  };

  const editingItem = editingId ? priceData.find((item) => item.id === editingId) : undefined;

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
          onExportData={handleExportData}
          onImportData={handleImportData}
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

      {currentScreen === 'edit' && editingItem && (
        <EditPriceScan
          item={editingItem}
          onBack={() => window.history.back()}
          onSave={handleSaveEdit}
        />
      )}
    </div>
  );
};

export default App;
