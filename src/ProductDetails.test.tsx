// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProductDetails from './ProductDetails';

type Props = React.ComponentProps<typeof ProductDetails>;
const props = (overrides: Partial<Props> = {}): Props => ({
  scannedPrice: '3.99', priceImage: null, productImage: null, isLocating: false, hasCoordinates: true, onRetryLocation: () => {},
  storeLocation: 'Kroger', setStoreLocation: () => {}, setScanStep: () => {}, retakePhoto: () => {}, saveAndContinue: () => {},
  itemName: 'Milk', setItemName: () => {}, tags: '', setTags: () => {}, quantity: 1, setQuantity: () => {}, quantity_units: 'each',
  setQuantityUnits: () => {}, brand: '', setBrand: () => {}, isSale: false, setIsSale: () => {}, expiresAt: null, setExpiresAt: () => {},
  matchCandidate: null, confirmedProductId: null, onConfirmMatch: () => {}, onRejectMatch: () => {}, ...overrides,
});

afterEach(cleanup);

describe('ProductDetails location requirement', () => {
  it('lets the user finish once we have a position', async () => {
    const save = vi.fn();
    render(<ProductDetails {...props({ saveAndContinue: save })} />);
    const done = screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement;
    expect(done.disabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.setup().click(done);
    expect(save).toHaveBeenCalled();
  });

  it('blocks saving without a position, explains why, and offers to ask again', async () => {
    const retry = vi.fn();
    const save = vi.fn();
    render(<ProductDetails {...props({ hasCoordinates: false, storeLocation: 'Walmart (typed by hand)', onRetryLocation: retry, saveAndContinue: save })} />);
    expect((screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toMatch(/need your location/i);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('does not show the warning while it is still locating', () => {
    render(<ProductDetails {...props({ hasCoordinates: false, isLocating: true })} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
