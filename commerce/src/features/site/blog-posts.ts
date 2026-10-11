// Posts on the Fullfilio blog. Kept as data so the list, the post pages and
// links stay in step; add a post by adding an entry (newest first).

export type Block = { h: string } | { p: string } | { list: string[] } | { tip: string }

export interface Post {
  slug: string
  title: string
  excerpt: string
  date: string
  minutes: number
  tag: 'Guide' | 'Integrations' | 'Couriers' | 'Fraud'
  body: Block[]
}

export const POSTS: Post[] = [
  {
    slug: 'how-returns-rts-work',
    title: 'How returns (RTS) work in Fullfilio',
    excerpt: 'A parcel the customer refuses is money you already spent. Here is how Fullfilio follows it back, puts the stock back and makes the next order from that number safer.',
    date: '2026-10-10',
    minutes: 4,
    tag: 'Guide',
    body: [
      { p: 'In cash-on-delivery commerce, a returned parcel (RTS, return to sender) costs twice: the delivery charge and the return charge, and the stock is stuck with the courier until it comes back. Fullfilio treats returns as part of the normal order flow so nothing gets lost on the way.' },
      { h: 'From "refused" to "returned"' },
      { list: [
        'The courier reports the refusal. The order moves to Return pending on its own, from the courier\'s status update.',
        'When the parcel reaches you, scan its label at the packing table. The order becomes Returned and the items go back into stock.',
        'If the order came from Shopify or WooCommerce, the store is updated too: the order is marked returned and the stock goes back there as well.',
      ] },
      { h: 'What it costs you, in one place' },
      { p: 'The return charge from the courier invoice is attached to the order, so Profit & Loss shows the real cost of that customer, not just the lost sale.' },
      { h: 'Making the next order safer' },
      { p: 'Every phone number carries its delivery history across couriers. A customer who refused parcels before is flagged when they order again, and you can ask for a small advance (for example ৳55 by bKash) before shipping.' },
    ],
  },
  {
    slug: 'connect-shopify-and-woocommerce',
    title: 'Connect Shopify or WooCommerce: what syncs, and which way',
    excerpt: 'Keep selling on your store and run calls, couriers and returns in Fullfilio. A clear list of what travels in each direction.',
    date: '2026-10-07',
    minutes: 5,
    tag: 'Integrations',
    body: [
      { p: 'Many sellers already have a Shopify or WooCommerce store they like. Fullfilio does not replace it; it takes over the work that happens after the customer clicks "Order".' },
      { h: 'From your store to Fullfilio' },
      { list: [
        'New orders, within seconds, with the customer, items, delivery area and the ad or source they came from.',
        'Products and their variants on the first sync, so stock and costs line up.',
        'Abandoned checkouts, so your team can call people who did not finish.',
      ] },
      { h: 'From Fullfilio back to your store' },
      { list: [
        'Confirmed and cancelled orders, as tags and statuses your store understands.',
        'Fulfilment with the courier\'s tracking number when a parcel is booked.',
        'Delivered and paid when the courier collects the cash.',
        'Returns: the order is marked returned and the stock is put back.',
        'Stock changes, so you never sell what is already promised elsewhere.',
      ] },
      { h: 'Connecting' },
      { p: 'Shopify connects with an app approval in your Shopify admin. For WooCommerce, install the Fullfilio Connect plugin and approve the connection on your own site; there are no keys to copy.' },
      { tip: 'You choose what syncs. Stock sync, for example, can stay off until your product list is matched.' },
    ],
  },
  {
    slug: 'stop-fake-cod-orders',
    title: 'Stop fake COD orders before they ship',
    excerpt: 'Delivery history across couriers is the best signal you have. How to use it to decide who gets an advance request, a call, or a quick approval.',
    date: '2026-10-04',
    minutes: 4,
    tag: 'Fraud',
    body: [
      { p: 'Most fake or careless orders look normal on the order form. What gives them away is what happened to the same phone number before.' },
      { h: 'Check before you call' },
      { p: 'For every new order, Fullfilio looks up how many parcels that number accepted and refused with Steadfast, Pathao, RedX and other couriers, and shows a single success rate next to the order.' },
      { h: 'Decide with rules, not guesswork' },
      { list: [
        'Good history: approve straight away.',
        'Little or no history: call first.',
        'Many refusals: ask for an advance before shipping, or block the number.',
      ] },
      { h: 'Duplicates and repeat tries' },
      { p: 'The same customer often orders twice by mistake. Fullfilio flags orders with the same phone or address placed close together and merges them in one click, so you do not ship two parcels.' },
      { tip: 'The rules live in Settings and apply to website, Shopify and WooCommerce orders alike.' },
    ],
  },
  {
    slug: 'bulk-courier-booking',
    title: 'Book 100 parcels in one click',
    excerpt: 'Choose the orders, choose the courier, print the labels. What happens behind the button, and how scanning keeps the packing table honest.',
    date: '2026-10-01',
    minutes: 3,
    tag: 'Couriers',
    body: [
      { p: 'Booking parcels one by one in each courier\'s panel is where busy days go to die. In Fullfilio you pick the ready orders and book them together.' },
      { h: 'One list, every courier' },
      { p: 'Connect Steadfast, Pathao, RedX and Carrybee once. When you book, each order shows the courier\'s success rate for that customer, so you can send risky areas with the courier that delivers best there.' },
      { h: 'Labels and scanning' },
      { list: [
        'Print labels and invoices in your own layout from the label builder.',
        'Scan each label as the parcel is packed; the order moves to Ready to ship.',
        'Scan again on return to put stock back.',
      ] },
      { h: 'Following every parcel' },
      { p: 'Courier status updates arrive on their own. Parcels that stop moving are flagged, and the courier\'s invoice is matched against what you expected to be paid.' },
    ],
  },
]

export const postBySlug = (slug: string | undefined) => POSTS.find((p) => p.slug === slug)

export const formatPostDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
