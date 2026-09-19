import type PriceData from './PriceData';

/**
 * Small status badges for a community price report (plan Phase 2 client
 * bullet: "unverified" / "unusual price" / "stale"). Own reports never show
 * these -- you already know who reported your own price.
 */
const PriceBadges = ({ item }: { item: PriceData }) => {
  if (item.origin !== 'community') return null;

  const unverified = item.authorTier === 'new' || item.authorTier === 'restricted';
  const unusual = item.reviewReason === 'price_outlier';
  const stale = item.isStale === true;

  if (!unverified && !unusual && !stale) return null;

  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {unverified && (
        <span
          title="This price was reported by an account with little history yet."
          className="text-[10px] uppercase tracking-wide bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded-full"
        >
          Unverified
        </span>
      )}
      {unusual && (
        <span
          title="This price looks far from what others have reported for this item -- could be a great sale, or a typo."
          className="text-[10px] uppercase tracking-wide bg-orange-100 text-orange-800 px-1.5 py-0.5 rounded-full"
        >
          Unusual price
        </span>
      )}
      {stale && (
        <span
          title="Nobody has confirmed or rescanned this price recently -- it may have changed."
          className="text-[10px] uppercase tracking-wide bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded-full"
        >
          Stale
        </span>
      )}
    </div>
  );
};

export default PriceBadges;
