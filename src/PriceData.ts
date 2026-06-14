export interface GroceryItem {
    id: string;
    name: string;
    quantity: number;
    unit: string;
    checked: boolean;
}

export default interface PriceData {
        price: string;
        store: string;
        date: string;
        priceImage: string | null;
        productImage: string | null;
        itemName: string;
        brand: string;
        tags: string[];
        quantity: number;
        quantity_units: string;
    latitude?: number | null;
    longitude?: number | null;
}