import PriceData from './PriceData';
import secret from './secret.json';

/**
 * Uses an API call to OpenRouter to parse a price image and extract relevant data.
 * @param priceImageData Base64 encoded price image data
 * @param productImageData Base64 encoded product image data
 * @returns Parsed price data as a PriceData object
 */
export async function parsePriceImage(priceImageData: string, productImageData: string) {
  const OPENROUTER_API_KEY = secret["OPENROUTER_API_KEY"];
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not defined in the environment variables.");
  }

  let data;
  if (import.meta.env.DEV) {
    // Use mock data in development
    console.log("Using mock data for price image parsing");
    data = await new Promise<any>(resolve => {
      setTimeout(() => {
        resolve({
          choices: [
            {
              message: {
                content: `{"price": "$2.99", "itemName": "Milk", "quantity": 1, "quantityUnits": "gallon", "tags": "dairy, beverage"}`
              }
            }
          ],
          // error: {message: 'test error'}
        });
      }, 2000);
    });
  } else {
    // Make actual API call in production
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        "model": "google/gemini-2.5-flash-lite",
        "messages": [
          {
            "role": "user",
            "content": [
              {
                "type": "text",
                "text": "I will show you two images. The first is a price tag and the second is the product itself. "
                  + "Please extract the price, itemName, brand, quantity, and quantityUnits. "
                  + "Use both images to improve accuracy. The product image may help identify the brand and item name. "
                  + "Return the data as a JSON object. Skip any fields not clearly visible in either image."
              },
              {
                "type": "image_url",
                "image_url": { "url": priceImageData }
              },
              {
                "type": "image_url",
                "image_url": { "url": productImageData }
              }
            ]
          }
        ],
        "max_tokens": 4000,
      })
    });
    data = await response.json();
    if (response.status === 429) {
      throw new Error("Rate limit exceeded. Please try again later.");
    }
  }

  if (data.error) {
    throw new Error(data.error.message);
  }

  const content = data.choices[0].message.content;
  const parsedData = content.substring(content.indexOf("{"), content.lastIndexOf("}") + 1);
  try {
    const parsedJSON = JSON.parse(parsedData);

    const parseTags = (rawTags: unknown): string[] => {
      if (!rawTags) return [];
      if (Array.isArray(rawTags)) return rawTags;
      if (typeof rawTags === 'string') return rawTags.split(',').map(t => t.trim());
      return [];
    };

    return {
      price: parsedJSON.price || "",
      store: "",
      // I choose to ignore date because we'll set it after the user is done editing
      priceImage: priceImageData,
      productImage: productImageData,
      itemName: parsedJSON.itemName || "",
      brand: parsedJSON.brand || "",
      tags: parseTags(parsedJSON.tags),
      quantity: parsedJSON.quantity || 1,
      quantity_units: parsedJSON.quantityUnits || "unit"
    } as PriceData;
  }
  catch (error) {
    throw error;
  }
}