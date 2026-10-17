import { X } from 'lucide-react';
import type { CheckoutNotice } from './sync/useSync';

const MESSAGES: Record<Exclude<CheckoutNotice, null>, { text: string; tone: string }> = {
  activating: { text: 'Payment received -- switching on your subscription...', tone: 'bg-blue-600' },
  active: { text: "You're subscribed. Every community price is unlocked. Thank you!", tone: 'bg-green-600' },
  pending: { text: "Payment received, but your subscription hasn't switched on yet. It should within a few minutes -- reopen the app, or check Community Prices > Membership.", tone: 'bg-amber-600' },
  canceled: { text: 'Checkout canceled. You have not been charged.', tone: 'bg-gray-700' },
};

/** Shown once after Stripe Checkout sends the browser back to the app (see sync/checkoutReturn.ts). */
const CheckoutBanner = ({ notice, onDismiss }: { notice: CheckoutNotice; onDismiss: VoidFunction }) => {
  if (!notice) return null;
  const { text, tone } = MESSAGES[notice];
  return (
    <div role="status" className={`fixed top-0 inset-x-0 z-50 ${tone} text-white text-sm px-4 py-3 shadow-md flex items-start`}>
      <p className="flex-1">{text}</p>
      {notice !== 'activating' && (
        <button onClick={onDismiss} aria-label="Dismiss" className="ml-3 p-1">
          <X size={16} />
        </button>
      )}
    </div>
  );
};

export default CheckoutBanner;
