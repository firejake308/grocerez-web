import { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, ArrowLeft } from 'lucide-react';
import PriceData from './PriceData';
import ProductDetails from './ProductDetails';
import { parsePriceImage } from './parsePriceImage';
import { newReportId } from '../shared/ids';
import { locateStore } from './sync/storeLocator';
import { createSyncApi } from './sync/api';
import { SYNC_API_URL, syncEnabled } from './sync/config';
import { localSyncStorage } from './sync/storage';
import type { ProductMatchCandidate } from '../shared/types';

const PriceScanner = ({ onBack, onSave }: {onBack: VoidFunction; onSave: (priceData: PriceData) => void}) => {
  // Track current step in the scanning process
  const [scanStep, setScanStep] = useState<'price' | 'product' | 'processing' | 'error' | 'details'>('price');
  
  // Image states
  const [priceImage, setPriceImage] = useState<string | null>(null);
  const [productImage, setProductImage] = useState<string | null>(null);
  
  // data states
  const [scannedPrice, setScannedPrice] = useState<string | null>(null);
  const [storeLocation, setStoreLocation] = useState('');
  const [isLocating, setIsLocating] = useState(false);
  const [storeLat, setStoreLat] = useState<number | null>(null);
  const [storeLng, setStoreLng] = useState<number | null>(null);
  const [itemName, setItemName] = useState('');
  const [tags, setTags] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [quantity_units, setQuantityUnits] = useState('each');
  const [isPriceProcessingComplete, setIsPriceProcessingComplete] = useState(false);
  const [brand, setBrand] = useState('');
  const [isSale, setIsSale] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [processingError, setProcessingError] = useState<string | null>(null);
  // Save-time product match prompt (plan section 8.4): "is this the same item we already know?"
  const [matchCandidate, setMatchCandidate] = useState<ProductMatchCandidate | null>(null);
  const [confirmedProductId, setConfirmedProductId] = useState<string | null>(null);

  // Camera refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const hasRequestedLocationRef = useRef(false);
  const hasRequestedMatchRef = useRef(false);
  const locationRequestIdRef = useRef(0);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);

  // Try to get location when reaching details step
  useEffect(() => {
    if (scanStep === 'details' && !hasRequestedLocationRef.current) {
      hasRequestedLocationRef.current = true;
      getStoreLocation();
      return;
    }

    if (scanStep !== 'details') {
      hasRequestedLocationRef.current = false;
      locationRequestIdRef.current += 1;
    }
  }, [scanStep]);

  // Look for an existing product this might be, once, on arriving at details.
  useEffect(() => {
    if (scanStep === 'details' && !hasRequestedMatchRef.current && syncEnabled()) {
      hasRequestedMatchRef.current = true;
      const token = localSyncStorage.getAuth()?.sessionToken ?? localSyncStorage.getDeviceToken();
      if (!token) return; // no device token yet (e.g. first launch); the matcher still runs server-side on push
      createSyncApi(SYNC_API_URL)
        .matchProduct(token, {
          itemName,
          brand: brand || undefined,
          tags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
          quantity: quantity > 0 ? quantity : undefined,
          quantityUnits: quantity_units || undefined,
          price: scannedPrice ?? undefined,
        })
        .then(({ candidates }) => {
          if (candidates.length > 0) setMatchCandidate(candidates[0]);
        })
        .catch((err) => console.warn('Product match lookup failed:', err));
    }
    if (scanStep !== 'details') {
      hasRequestedMatchRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanStep]);

  const confirmMatch = () => {
    if (matchCandidate) setConfirmedProductId(matchCandidate.productId);
    setMatchCandidate(null);
  };

  const rejectMatch = () => {
    setMatchCandidate(null);
  };

  const stopCamera = useCallback(() => {
    cameraStreamRef.current?.getTracks().forEach(track => track.stop());
    cameraStreamRef.current = null;
  }, []);

  const startCamera = useCallback(async () => {
    try {
      stopCamera(); // Ensure any existing stream is stopped
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment' } 
      });
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      
      cameraStreamRef.current = stream;
      setHasPermission(true);
    } catch (err) {
      console.error("Error accessing camera:", err);
      setHasPermission(false);
    }
  }, [stopCamera]);

  // Start camera when component mounts or when switching between price and product photos
  useEffect(() => {
    if (scanStep === 'price' || scanStep === 'product') {
      startCamera();
    }
    
    // Clean up function
    return () => {
      stopCamera();
    };
  }, [scanStep, startCamera, stopCamera]);

  const captureImage = () => {
    if (videoRef.current && canvasRef.current) {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      
      const context = canvas.getContext('2d');
      context?.drawImage(video, 0, 0, canvas.width, canvas.height);
      
      const imageDataUrl = canvas.toDataURL('image/jpeg');
      
      if (scanStep === 'price') {
        setPriceImage(imageDataUrl);
        setScanStep('product'); // Move to product photo step
      } else if (scanStep === 'product') {
        setProductImage(imageDataUrl);
        stopCamera();
        setScanStep('processing'); // Set to processing step before starting
        processImages(priceImage, imageDataUrl); // Process both images after getting product photo
      }
    }
  };

  // Add new function to process both images
  const processImages = async (priceImage: string | null, productImage: string | null) => {
    if (!priceImage || !productImage) return;
    
    try {
      const data = await parsePriceImage(priceImage, productImage);
      setScannedPrice(data.price);
      setItemName(data.itemName);
      setBrand(data.brand);
      setTags(data.tags.join(', '));
      setQuantity(data.quantity);
      setQuantityUnits(data.quantity_units);
      setIsSale(data.isSale);
      setExpiresAt(data.expiresAt);
      setIsPriceProcessingComplete(true);
      setScanStep('details');
    } catch (error) {
      console.error("Error processing images:", error);
      setProcessingError(error instanceof Error ? error.message : "Failed to process images");
      setScanStep('error');  // Change this line
    }
  };

  const getStoreLocation = () => {
    const requestId = locationRequestIdRef.current + 1;
    locationRequestIdRef.current = requestId;
    setIsLocating(true);

    if (!navigator.geolocation) {
      setStoreLocation(""); // Empty to prompt manual entry
      setIsLocating(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        setStoreLat(latitude);
        setStoreLng(longitude);
        try {
          // Sync server's geo proxy when configured, public Overpass/Nominatim otherwise.
          const located = await locateStore(latitude, longitude);
          if (locationRequestIdRef.current !== requestId) return;
          setStoreLocation(located.label);
          setStoreLat(located.lat);
          setStoreLng(located.lon);
        } catch (error) {
          console.error("Store lookup error:", error);
          if (locationRequestIdRef.current !== requestId) return;
          setStoreLocation(""); // Empty to prompt manual entry
        } finally {
          if (locationRequestIdRef.current === requestId) setIsLocating(false);
        }
      },
      (error) => {
        console.error("Geolocation error:", error);
        if (locationRequestIdRef.current !== requestId) return;
        setStoreLocation(""); // Empty to prompt manual entry
        setStoreLat(null);
        setStoreLng(null);
        setIsLocating(false);
      },
      { timeout: 10000 }
    );
  };

  const retakePhoto = () => {
    if (scanStep === 'product') {
      setProductImage(null);
      startCamera();
    } else if (scanStep === 'details') {
      setScanStep('product');
      setProductImage(null);
    }
  };

  const saveAndContinue = () => {
    if (!isPriceProcessingComplete) {
      // Show warning that price processing isn't complete
      alert("Please wait for price processing to complete");
      return;
    }
    
    if (scannedPrice && productImage && storeLocation) {
      const completeData: PriceData = {
        id: newReportId(),
        updatedAt: new Date().toISOString(),
        origin: 'mine',
        isSale,
        expiresAt: isSale ? expiresAt : null,
        price: scannedPrice,
        store: storeLocation,
        date: new Date().toISOString().split('T')[0],
        priceImage: priceImage,
        productImage: productImage,
        itemName: itemName,
        brand: brand,
        tags: tags.split(',').map(tag => tag.trim()),
        quantity: quantity,
        quantity_units: quantity_units,
        latitude: storeLat,
        longitude: storeLng,
        ...(confirmedProductId ? { productId: confirmedProductId } : {}),
      };
      
      if (onSave) {
        onSave(completeData);
      }
    }
  };

  if (hasPermission === false && (scanStep === 'price' || scanStep === 'product')) {
    return (
      <div className="flex flex-col h-screen bg-gray-100 p-4">
        <div className="flex items-center mb-4">
          <button onClick={onBack} className="p-2">
            <ArrowLeft size={24} />
          </button>
          <h1 className="text-xl font-semibold ml-2">Price Scanner</h1>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center">
          <div className="bg-red-100 text-red-700 p-4 rounded-lg max-w-sm text-center">
            <p className="font-medium mb-2">Camera access denied</p>
            <p>Please enable camera access in your browser settings to use the price scanner.</p>
          </div>
        </div>
      </div>
    );
  }

  // Price Photo Screen
  if (scanStep === 'price') {
    return (
      <div className="flex flex-col h-screen bg-black">
        {/* Header */}
        <div className="bg-black p-4 flex items-center">
          <button onClick={onBack} className="text-white p-2">
            <ArrowLeft size={24} />
          </button>
          <h1 className="text-xl font-semibold text-white ml-2">Scan Price Tag</h1>
        </div>

        {/* Camera View */}
        <div className="flex-1 relative flex items-center justify-center">
          <video 
            ref={videoRef} 
            autoPlay 
            playsInline 
            className="h-full w-full object-cover"
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="border-2 border-white w-4/5 h-1/3 rounded-md opacity-70"></div>
          </div>
          <canvas ref={canvasRef} className="hidden" />
        </div>

        {/* Camera Controls */}
        <div className="p-4 bg-black">
          <div className="text-white text-center mb-2">Position the price tag in the frame</div>
          <button 
            onClick={captureImage}
            className="w-16 h-16 mx-auto bg-white rounded-full flex items-center justify-center"
          >
            <Camera size={32} className="text-black" />
          </button>
        </div>
      </div>
    );
  }

  // Product Photo Screen
  if (scanStep === 'product') {
    return (
      <div className="flex flex-col h-screen bg-black">
        {/* Header */}
        <div className="bg-black p-4 flex items-center">
          <button onClick={() => setScanStep('price')} className="text-white p-2">
            <ArrowLeft size={24} />
          </button>
          <h1 className="text-xl font-semibold text-white ml-2">Scan Product</h1>
        </div>

        {/* Camera View */}
        <div className="flex-1 relative flex items-center justify-center">
          <video 
            ref={videoRef} 
            autoPlay 
            playsInline 
            className="h-full w-full object-cover"
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="border-2 border-white w-4/5 h-1/2 rounded-md opacity-70"></div>
          </div>
          <canvas ref={canvasRef} className="hidden" />
        </div>

        {/* Price Info & Camera Controls */}
        <div className="p-4 bg-black">
          <div className="bg-white bg-opacity-10 p-2 rounded-md mb-4 text-center">
            {isPriceProcessingComplete ? (
              <p className="text-white">Price detected: <span className="font-bold text-lg">{scannedPrice}</span></p>
            ) : (
              <div className="text-white flex items-center justify-center space-x-2">
                <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white"></div>
                <span>Processing price...</span>
              </div>
            )}
          </div>
          <div className="text-white text-center mb-2">Now take a picture of the product</div>
          <button 
            onClick={captureImage}
            className="w-16 h-16 mx-auto bg-white rounded-full flex items-center justify-center"
          >
            <Camera size={32} className="text-black" />
          </button>
        </div>
      </div>
    );
  }

  if (scanStep === 'processing') {
    return (
      <div className="flex flex-col h-screen bg-gray-900">
        <div className="flex-1 flex flex-col items-center justify-center p-6">
          <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-white mb-8"></div>
          <h2 className="text-white text-xl font-semibold mb-2">Processing your price...</h2>
          <p className="text-gray-400 text-center mb-8">This might take a few moments</p>
            <div className="bg-gray-800 p-6 rounded-lg max-w-sm text-center">
              <p className="text-gray-300 mb-4">
                Tired of waiting? Upgrade to Pro and get access to faster models
              </p>
              <button className="bg-green-500 hover:bg-green-600 text-white font-semibold py-2 px-6 rounded-lg transition-colors">
                Upgrade to Pro
              </button>
            </div>
        </div>
      </div>
    );
  }

  if (scanStep === 'error') {
    return (
      <div className="flex flex-col h-screen bg-gray-900">
        <div className="flex-1 flex flex-col items-center justify-center p-6">
          <div className="bg-red-900/50 p-8 rounded-lg max-w-sm text-center">
            <h2 className="text-white text-xl font-semibold mb-4">Processing Error</h2>
            <p className="text-red-400 mb-6">{processingError}</p>
            <button 
              onClick={() => {
                setProcessingError(null);
                setPriceImage(null);
                setProductImage(null);
                setScanStep('price');
              }}
              className="w-full bg-red-500 hover:bg-red-600 text-white font-semibold py-3 px-4 rounded-lg transition-colors"
            >
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Details Screen
  if (scanStep === 'details') {
    return <ProductDetails 
      scannedPrice={scannedPrice}
      priceImage={priceImage}
      productImage={productImage}
      isLocating={isLocating}
      storeLocation={storeLocation}
      setStoreLocation={setStoreLocation}
      setScanStep={setScanStep}
      retakePhoto={retakePhoto}
      saveAndContinue={saveAndContinue}
      itemName={itemName}
      setItemName={setItemName}
      tags={tags}
      setTags={setTags}
      quantity={quantity}
      setQuantity={setQuantity}
      quantity_units={quantity_units}
      setQuantityUnits={setQuantityUnits}
      brand={brand}
      setBrand={setBrand}
      isSale={isSale}
      setIsSale={setIsSale}
      expiresAt={expiresAt}
      setExpiresAt={setExpiresAt}
      matchCandidate={matchCandidate}
      confirmedProductId={confirmedProductId}
      onConfirmMatch={confirmMatch}
      onRejectMatch={rejectMatch}
    />;
  }

  return null;
};

export default PriceScanner;