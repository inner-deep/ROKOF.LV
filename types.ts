
export enum Category {
  STRIPS = 'LED Strips',
  POWER = 'Power Supplies',
  PROFILES = 'Profiles',
  CONTROLLERS = 'Controllers',
  ACCESSORIES = 'Accessories'
}

export type ChipType = 'SMD' | 'COB' | 'CSP';

export interface ProductVariant {
  id: string;
  sku: string;
  label: string;
  price: number;
  b2bPrice: number;
  specificationsOverride?: Partial<Product['specifications']>;
}

export interface Product {
  id: string;
  sku: string; // Артикул (например, SOB-320-24V)
  brand?: string; // Brand name
  title: Record<Language, string>; // Название товара (поддержка языков)
  description: Record<Language, string>; // Описание (поддержка языков)
  category: 'LED_STRIP' | 'PROFILE' | 'POWER_SUPPLY' | 'CONTROLLER';
  price: number; // Цена за единицу
  b2bPrice: number; // Цена для B2B (сохраняем функционал)
  unit: 'm' | 'pcs'; // Единица измерения: метры или штуки
  stockQuantity: number; // Остаток на складе
  warrantyMonths: number; // Garantijas termiņš mēnešos
  images: string[]; // Ссылки на фото
  onSale?: boolean;
  originalPrice?: number;
  lowestPrice30d?: number;
  energyClass?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  technicalDocumentationUrl?: string;
  euResponsiblePerson?: {
    name: string;
    address: string;
    email: string;
    phone?: string;
  };
  specifications: {
    voltage?: '12V' | '24V' | '48V';
    powerPerMeter?: number; // Вт/м
    colorTemperature?: string; // например, 3000K
    ipRating?: string; // например, IP20, IP67
    // Дополнительные поля для совместимости
    [key: string]: any;
  };
  createdAt: Date;
}

export interface OmnivaLocation {
  ZIP: string;
  NAME: string;
  TYPE: string;
  A0_NAME: string; // Country code
  A1_NAME: string; // Region
  A2_NAME: string; // City
  A3_NAME: string;
  A5_NAME: string; // Full address
  A7_NAME: string;
  X_COORDINATE: string;
  Y_COORDINATE: string;
  SERVICE_7_DAYS: string;
}

export interface DPDLocation {
  id: string;
  name: string;
  city: string;
  address: string;
  zip: string;
  country: string;
}

export interface OrderItem {
  id: string;
  productId?: string;
  sku: string;
  title: string; // Snapshot of product title
  image?: string; // Snapshot of product image
  quantity: number;
  price: number;
  priceAtPurchase?: number; // Added for historical price accuracy
  total?: number; // Prisma field
  weightPerMeter?: number;
  warrantyUntil?: string; // ISO date string
}

export interface Order {
  id: string;
  invoiceNumber?: string;
  rkfInvoiceNumber?: string;
  pavadzimeNumber?: string;
  userId: string;
  date: string;
  createdAt: string;
  paidAt?: string;
  preInvoiceSentAt?: string;
  status: 'NEW' | 'PAID' | 'PROCESSING' | 'IN_DELIVERY' | 'SHIPPED' | 'COMPLETED' | 'CANCELLED';
  total: number;
  totalAmount?: number; // Prisma field
  subtotal?: number; // Prisma field
  vatAmount?: number; // Prisma field
  deliveryCost: number;
  deliveryMethod: string;
  shippingMethod?: string;
  shippingAddress?: string;
  deliveryAddress?: string; // Prisma field
  stationId?: string;
  itemsCount: number;
  items: OrderItem[];
  deliveryDocumentUrl?: string;
  invoiceUrl?: string;
  prepaymentInvoiceUrl?: string;
  user?: User; // Included in some queries
  customerInfo?: {
    name: string;
    email: string;
    phone: string;
    address: string;
    company?: string;
    street?: string;
    building?: string;
    apartment?: string;
    city?: string;
    district?: string;
    zipCode?: string;
    country?: string;
    regNo?: string;
    vatNo?: string;
  };
  comment?: string;
}

export interface Invoice {
  id: string;
  orderId: string;
  date: string;
  amount: number;
  url: string;
}

export interface User {
  id: string;
  email: string;
  role: 'ADMIN' | 'CUSTOMER';
  type: 'INDIVIDUAL' | 'BUSINESS' | 'UNREGISTERED';
  tier: 'BRONZE' | 'SILVER' | 'GOLD';
  
  // Profile fields
  firstName: string;
  lastName: string;
  phone: string;
  
  // B2B specific fields
  companyName?: string;
  regNo?: string;
  vatNo?: string;
  legalAddress?: string;
  
  // Additional fields for delivery and billing
  physicalAddress?: string;
  street?: string;
  building?: string;
  apartment?: string;
  city?: string;
  district?: string;
  zipCode?: string;
  country?: string;
  bankName?: string;
  swift?: string;
  bankAccount?: string;
  
  language?: string;
  
  createdAt: Date;
  passwordHash?: string;
  discountLevel: number;
  token?: string;
}

export interface CartItem extends Product {
  quantity: number;
  selectedVariantId?: string;
}

export type Language = 'LV' | 'RU' | 'EN';

export type Page = 'home' | 'catalog' | 'product' | 'about' | 'partners' | 'contacts' | 'technical' | 'comparison' | 'account' | 'distanceContract' | 'privacyPolicy' | 'deliveryPayment' | 'returnsPolicy';
