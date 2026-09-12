import PriceData from './PriceData';

/**
 * Uses an API call to OpenRouter to parse a price image and extract relevant data.
 * @param priceImageData Base64 encoded price image data
 * @param productImageData Base64 encoded product image data
 * @returns Parsed price data as a PriceData object
 */
export async function parsePriceImage(priceImageData: string, productImageData: string) {
  const OPENROUTER_API_KEY = import.meta.env.VITE_OPENROUTER_API_KEY;
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
        "model": "google/gemma-4-26b-a4b-it",
        "messages": [
          {
            "role": "user",
            "content": [
              {
                "type": "text",
                "text": "I will show you two images. The first is a price tag and the second is the product itself. "
                  + "Please extract the price, itemName, brand, quantity, and quantityUnits. "
                  + "Use both images to improve accuracy. The product image may help identify the brand and item name. "
                  + "Expand all abbreviations in itemName and brand (e.g. 'Org' → 'Organic', 'Chkn' → 'Chicken', 'Stk' → 'Steak', 'Whl' → 'Whole', 'Veg' → 'Vegetable'). "
                  + "For quantityUnits, always use the full singular unit name (e.g. 'oz' → 'ounce', 'lb' → 'pound', 'fl oz' → 'fluid ounce', 'ct' → 'count', 'pkg' → 'package', 'gal' → 'gallon', 'qt' → 'quart', 'pt' → 'pint'). "
                  + "For products sold as a multipack of individually-used disposable items (e.g. tissues, wipes, paper towels, diapers, napkins), report quantity as the total count of individual units across the whole package, not the number of boxes/rolls/packs — for example, 4 boxes of tissues at 65 tissues per box is quantity 260 with quantityUnits 'tissue'. Use the count printed per box/roll together with the number of boxes/rolls to compute this total when both are visible; otherwise fall back to the box/roll/pack count. "
                  + "The price is normally just the single dollar amount shown as the main price on the tag — report that number as-is. Only divide it when the tag is explicitly advertising a multi-buy deal for multiple separate purchases, phrased like '10/10.00', '3 for $11.11', 'buy 3 get 1 free', or a discount tier — in that case only, compute and report price as the price of a single unit, as a plain decimal number, never a slash, fraction, or the word 'for' (e.g. '10/10.00' becomes 1.00). Do NOT divide the price just because the package itself contains multiple items (e.g. a '4 count' box, a '12 pack', a '4/160 ct' multi-box case) — that count describes the package contents, not a multi-buy price deal, so the full tag price is the answer as long as only one item of that package is being purchased. "
                  + "If the tag lists two prices gated by a loyalty card or membership, which one to report depends on whether that card/membership is free: if it's a free loyalty card (e.g. a store's free rewards/plus card, the common case for 'regular price' vs 'price with card' tags), report the lower with-card price. If the discount requires a paid membership on top of otherwise-normal shopping (e.g. a 'Prime member price' shown next to a regular price), report the higher regular, non-member price instead, since most shoppers won't have paid for that membership. At a warehouse club where membership is required just to shop there at all (e.g. Costco, Sam's Club), there is no separate non-member price to choose between — just report whatever single price is shown. "
                  + "For loose produce sold by weight with no packaging (e.g. apples piled in a bin, priced per pound), include the tag 'bulk' and do not report a 'bagged' or 'bag' tag. For the same kind of item sold pre-packaged in a bag (e.g. a 3 lb bag of apples), include the tag 'bagged' and do not report a 'bulk' tag. Never include both. "
                  + "In addition to price, itemName, brand, quantity, and quantityUnits, infer 2-4 tags: lowercase "
                  + "generic grocery search terms a shopper might type to find this product, based on what kind of "
                  + "product it is — not text printed on the packaging or price tag. Favor broader category words that "
                  + "don't already appear in itemName. A common, accurate category phrase for how this type of product is "
                  + "normally sold (e.g. 'shredded cheese' for a bag of shredded cheese, 'sliced cheese' for deli-style "
                  + "cheese slices) is a good tag on its own and should NOT be swapped out for a narrower-sounding "
                  + "alternative just to seem more specific (e.g. don't replace 'shredded cheese' with 'italian cheese' or "
                  + "'pizza cheese'). The only tags to avoid are whole-department, catch-all words that describe a huge "
                  + "swath of unrelated grocery items rather than this product specifically — e.g. 'produce', 'food', "
                  + "'grocery', 'snack', 'dairy', or 'beverage' used by themselves. It's fine, and often correct, to use a "
                  + "well-known brand name generically as a tag even when the actual brand is a different manufacturer "
                  + "(e.g. tagging a store-brand facial tissue 'kleenex', or a store-brand sandwich cookie 'oreo'), since "
                  + "shoppers commonly search that way — just don't put that generic name in the brand field itself, which "
                  + "should always be the true manufacturer/brand shown on the packaging. Tags must describe only the "
                  + "product actually pictured, not other products commonly bought alongside it (e.g. a bag of pita chips "
                  + "should not be tagged 'dip' or 'hummus' just because people often eat them together). For example, a "
                  + "package showing 'Buldak Spicy Ramen' should get tags like 'noodles' and 'instant noodles' even though "
                  + "neither word is printed on it; 'Frozen Greek Yogurt Bars' should get 'yogurt' and 'frozen dessert'. "
                  + "Return tags as a JSON array of strings. "
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
    if (response.status === 429) {
      throw new Error("Rate limit exceeded. Please try again later.");
    }

    const rawBody = await response.text();
    try {
      data = JSON.parse(rawBody);
    } catch {
      console.error("Non-JSON response from price parsing service:", rawBody);
      throw new Error("The price parsing service is temporarily unavailable. Please try again.");
    }
  }

  if (data.error) {
    throw new Error(data.error.message);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("The AI service returned an empty response. Please try again.");
  }

  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1) {
    console.error("No JSON object found in AI response:", content);
    throw new Error("Couldn't read the price and product details from that photo. Please try again.");
  }

  const parsedData = content.substring(start, end + 1);
  const parsedJSON = JSON.parse(parsedData);

  const parseTags = (rawTags: unknown): string[] => {
    if (!rawTags) return [];
    if (Array.isArray(rawTags)) return rawTags;
    if (typeof rawTags === 'string') return rawTags.split(',').map(t => t.trim());
    return [];
  };

  const parsePrice = (rawPrice: unknown): string | number => {
    if (typeof rawPrice === 'string' && rawPrice.startsWith('$')) {
      return rawPrice.slice(1);
    }
    return rawPrice as string | number;
  };

  return {
    price: parsePrice(parsedJSON.price) || "",
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