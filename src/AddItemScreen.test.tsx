// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AddItemScreen from './AddItemScreen';
import type PriceData from './PriceData';
import type { SyncController } from './sync/useSync';

const price = (overrides: Partial<PriceData>): PriceData => ({
  id: 'x', price: '1.00', store: 'Kroger', date: '2026-10-20', priceImage: null, productImage: null, itemName: 'Bananas', brand: '',
  tags: [], quantity: 1, quantity_units: 'lb', updatedAt: '2026-10-20T00:00:00.000Z', ...overrides,
});

const fakeSync = (search: SyncController['search']): SyncController => ({
  enabled: true, auth: null, community: [], locked: [], discover: [], discoverLocked: [], search,
} as unknown as SyncController);

const setOnline = (online: boolean) => Object.defineProperty(window.navigator, 'onLine', { value: online, configurable: true });

const runSearch = async (term: string) => {
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox'), term);
  await user.click(screen.getByRole('button', { name: 'Search' }));
};

afterEach(() => {
  cleanup();
  setOnline(true);
});

describe('AddItemScreen search', () => {
  it('online: shows every server match plus the locked-products card, merged with the device\'s own prices', async () => {
    const search = vi.fn(async () => ({
      items: [
        price({ id: 'c1', itemName: 'Premium Bananas', store: 'H-E-B', price: '0.49', origin: 'community' }),
        price({ id: 'c2', itemName: 'bananas', store: 'Kroger', price: '0.55', origin: 'community' }),
        price({ id: 'mine', itemName: 'Bananas', store: 'Costco', price: '0.40', origin: 'community' }), // the server's copy of my own report
      ],
      locked: [{ productId: 'p9', canonicalName: 'Organic Bananas', storeCount: 2, reportCount: 3, newestDate: '2026-10-29' }],
      truncated: false,
    }));
    const own = price({ id: 'mine', itemName: 'Bananas', store: 'Costco', price: '0.40', origin: 'mine' });
    render(<AddItemScreen onBack={() => {}} onSave={() => {}} priceData={[own]} sync={fakeSync(search)} />);
    await runSearch('bananas');

    await waitFor(() => expect(screen.getByText('Premium Bananas')).toBeTruthy());
    expect(search).toHaveBeenCalledWith('bananas');
    expect(screen.getAllByRole('radio')).toHaveLength(3); // H-E-B, Kroger, and my own Costco report (not duplicated)
    expect(screen.getByText(/Organic Bananas/)).toBeTruthy();
  });

  it('offline: searches the local cache and never calls the server', async () => {
    setOnline(false);
    const search = vi.fn();
    const cached = price({ id: 'c1', itemName: 'Cached Bananas', origin: 'community' });
    render(<AddItemScreen onBack={() => {}} onSave={() => {}} priceData={[cached]} sync={fakeSync(search as never)} />);
    await runSearch('bananas');

    await waitFor(() => expect(screen.getByText('Cached Bananas')).toBeTruthy());
    expect(search).not.toHaveBeenCalled();
  });

  it('falls back to the local cache, and says so, when the server cannot be reached', async () => {
    const search = vi.fn(async () => { throw new Error('network'); });
    const cached = price({ id: 'c1', itemName: 'Cached Bananas', origin: 'community' });
    render(<AddItemScreen onBack={() => {}} onSave={() => {}} priceData={[cached]} sync={fakeSync(search)} />);
    await runSearch('bananas');

    await waitFor(() => expect(screen.getByText('Cached Bananas')).toBeTruthy());
    expect(screen.getByText(/Could not reach the server/)).toBeTruthy();
  });
});
