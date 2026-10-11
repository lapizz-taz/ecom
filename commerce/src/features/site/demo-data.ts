// Sample data for the product site's interactive demos. Illustrative only:
// nothing here is read from or written to a real business.

export type HeroImage = 'stone' | 'dusk' | 'sand'

export const HERO_IMAGES: Record<HeroImage, { label: string; className: string }> = {
  stone: { label: 'Stone', className: 'from-zinc-500 to-zinc-900' },
  dusk: { label: 'Dusk', className: 'from-[#2142e7] to-[#1a0b3d]' },
  sand: { label: 'Sand', className: 'from-amber-300 to-orange-700' },
}

export const DEMO_PRODUCTS = [
  { name: 'Black spike bracelet', price: 690, tone: 'from-zinc-700 to-black' },
  { name: 'Rhinestone belt', price: 1490, tone: 'from-stone-400 to-stone-800' },
  { name: 'Ancient ring', price: 450, tone: 'from-amber-200 to-amber-700' },
  { name: 'Star chain', price: 820, tone: 'from-slate-300 to-slate-700' },
  { name: 'Venom bracelet', price: 590, tone: 'from-emerald-700 to-zinc-900' },
  { name: 'Cross necklace', price: 750, tone: 'from-neutral-300 to-neutral-800' },
  { name: 'Diesel belt', price: 1290, tone: 'from-orange-900 to-black' },
  { name: '5 layer bracelet', price: 980, tone: 'from-sky-800 to-zinc-900' },
] as const

/** Where an order is: the web queue (NEW, CALLING) or the approved pipeline. */
export type DemoStatus = 'NEW' | 'CALLING' | 'PENDING' | 'RTS' | 'SHIPPED' | 'DELIVERED' | 'RETURNED'

export interface DemoOrder {
  id: string
  name: string
  phone: string
  city: string
  amount: number
  items: string
  status: DemoStatus
  courier?: string
  tracking?: string
  /** Delivery success with each courier for this phone number, in percent. */
  history: Array<[string, number]>
}

export const DEMO_ORDERS: DemoOrder[] = [
  { id: 'ISO-10482', name: 'Rahim Uddin', phone: '017•• ••• 482', city: 'Dhaka', amount: 1290, items: 'Black spike bracelet', status: 'CALLING', history: [['Steadfast', 92], ['Pathao', 88], ['RedX', 100]] },
  { id: 'ISO-10481', name: 'Nusrat Jahan', phone: '018•• ••• 207', city: 'Chattogram', amount: 2450, items: 'Rhinestone belt, Star chain', status: 'NEW', history: [['Steadfast', 96], ['Pathao', 90]] },
  { id: 'ISO-10480', name: 'Tanvir Ahmed', phone: '019•• ••• 315', city: 'Sylhet', amount: 890, items: 'Ancient ring ×2', status: 'NEW', history: [['Steadfast', 40], ['Pathao', 33], ['RedX', 50]] },
  { id: 'ISO-10479', name: 'Mitu Akter', phone: '016•• ••• 940', city: 'Khulna', amount: 3100, items: 'Diesel belt, Venom bracelet', status: 'SHIPPED', courier: 'Steadfast', tracking: 'SF-88213', history: [['Steadfast', 100]] },
  { id: 'ISO-10478', name: 'Sabbir Hossain', phone: '017•• ••• 118', city: 'Rajshahi', amount: 1750, items: 'Cross necklace', status: 'PENDING', history: [['Pathao', 94], ['RedX', 90]] },
  { id: 'ISO-10477', name: 'Farhana Islam', phone: '015•• ••• 664', city: 'Gazipur', amount: 640, items: 'Star chain', status: 'RTS', history: [['Steadfast', 85]] },
  { id: 'ISO-10476', name: 'Arif Khan', phone: '018•• ••• 573', city: 'Dhaka', amount: 1980, items: '5 layer bracelet ×2', status: 'DELIVERED', courier: 'Pathao', tracking: 'DA2610XK', history: [['Pathao', 97]] },
  { id: 'ISO-10475', name: 'Sadia Islam', phone: '013•• ••• 802', city: 'Cumilla', amount: 1120, items: 'Ancient ring', status: 'DELIVERED', courier: 'RedX', tracking: '24A1173', history: [['RedX', 91], ['Steadfast', 89]] },
  { id: 'ISO-10474', name: 'Fahim Chowdhury', phone: '019•• ••• 455', city: 'Narayanganj', amount: 540, items: 'Venom bracelet', status: 'RETURNED', courier: 'Steadfast', tracking: 'SF-88107', history: [['Steadfast', 61]] },
  { id: 'ISO-10473', name: 'Riya Das', phone: '017•• ••• 390', city: 'Barishal', amount: 1430, items: 'Rhinestone belt', status: 'PENDING', history: [['Steadfast', 93], ['Pathao', 95]] },
]

export const DEMO_RANGES = {
  today: { label: 'Today', sales: 18450, orders: 23, delivered: 91, profit: 4210, delta: 12, bars: [3, 5, 2, 6, 8, 4, 7, 9, 5, 6, 8, 10] },
  week: { label: '7 days', sales: 142300, orders: 168, delivered: 88, profit: 31900, delta: 8, bars: [42, 55, 38, 61, 70, 52, 66] },
  month: { label: '30 days', sales: 612800, orders: 731, delivered: 87, profit: 129400, delta: 15, bars: [42, 55, 38, 61, 70, 52, 66, 74, 58, 81, 77, 90, 72, 85, 69, 88, 94, 79, 83, 91] },
} as const

export type DemoRange = keyof typeof DEMO_RANGES

export const DEMO_COURIERS = [
  { name: 'Steadfast', parcels: 412, delivered: 92, cod: 186400 },
  { name: 'Pathao', parcels: 238, delivered: 89, cod: 102900 },
  { name: 'RedX', parcels: 121, delivered: 94, cod: 54300 },
  { name: 'Carrybee', parcels: 46, delivered: 86, cod: 18700 },
] as const
