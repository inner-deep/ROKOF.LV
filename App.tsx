
import React, { useState, useEffect, useMemo, ErrorInfo, Component } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { X, ShoppingCart, Trash2, ArrowRight, List, LayoutGrid, SlidersHorizontal, Zap, SearchX, Truck, FileText, Shield, CreditCard, RefreshCcw, Percent } from 'lucide-react';
import { TRANSLATIONS, VAT_RATE } from './constants';
import { Language, User, CartItem, Page, Product } from './types';
import { storeService } from './services/storeService';
import { calculateTotals, getPersonalizedPrice } from './src/utils/calculations';
import Header from './components/Header';
import ProductRow from './components/ProductRow';
import ProductCard from './components/ProductCard';
import ProductDetail from './components/ProductDetail';
import AuthModal from './components/AuthModal';
import CheckoutModal from './components/CheckoutModal';
import UserDashboard from './components/UserDashboard';
import AdminPanel from './components/AdminPanel';
import Toast from './components/Toast';
import Footer from './components/Footer';
import ContactsPage from './components/ContactsPage';
import PartnersPage from './components/PartnersPage';
import { PrivacyAgeSection } from './components/Legal/PrivacySection';
import PrivacyPolicy from './components/Legal/PrivacyPolicy';
import { CookieBanner, activateAnalytics } from './components/Legal/CookieBanner';
import ForgotPassword from './components/ForgotPassword';
import ResetPassword from './components/ResetPassword';

import InvoiceEditor from './src/components/admin/invoices/InvoiceEditor';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = { hasError: false };

  constructor(props: ErrorBoundaryProps) {
    super(props);
  }

  static getDerivedStateFromError(_: Error): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="fixed inset-0 z-[100] bg-rose-50/95 flex flex-col items-center justify-center animate-in fade-in duration-300">
          <div className="w-16 h-16 bg-rose-100 text-rose-600 flex items-center justify-center rounded-full mb-4">
            <X size={32} />
          </div>
          <p className="text-[11px] font-black uppercase tracking-widest text-rose-900">Something went wrong.</p>
          <button 
            onClick={() => window.location.reload()} 
            aria-label="Reload Application"
            className="mt-4 px-6 py-3 bg-rose-600 text-white text-[10px] font-black uppercase tracking-widest focus:outline-none focus:ring-2 focus:ring-rose-600 focus:ring-offset-2"
          >Reload App</button>
        </div>
      );
    }
    return (this as any).props.children;
  }
}

interface ToastItem {
  id: string;
  message: string;
}

const FREE_DELIVERY_LIMIT = 200.00;

const ProductDetailRoute = ({ products, addToCart, language, currentUser, wishlist, toggleWishlist }: any) => {
  const { id } = useParams();
  const navigate = useNavigate();
  const product = products.find((p: Product) => p.id === id);
  
  if (!product) {
    return <div className="py-20 text-center">Product not found</div>;
  }
  
  return (
    <ProductDetail 
      product={product} 
      onClose={() => navigate(-1)} 
      onAddToCart={addToCart} 
      language={language} 
      user={currentUser} 
      isWishlisted={wishlist.includes(product.id)}
      onToggleWishlist={() => toggleWishlist(product.id)}
    />
  );
};

const AppContent: React.FC = () => {
  const [language, setLanguage] = useState<Language>('LV');
  const [products, setProducts] = useState<Product[]>([]);
  const [serverFacets, setServerFacets] = useState<any>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [wishlist, setWishlist] = useState<string[]>([]);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [authType, setAuthType] = useState<'INDIVIDUAL' | 'BUSINESS'>('INDIVIDUAL');
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [isAdminOpen, setIsAdminOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [viewLayout, setViewLayout] = useState<'grid' | 'list'>('list');
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  
  const { t, i18n } = useTranslation();

  useEffect(() => {
    i18n.changeLanguage(language);
  }, [language, i18n]);

  useEffect(() => {
    const consent = localStorage.getItem('rokof_cookie_consent');
    
    // Проверяем наличие согласия И отсутствие флага инициализации в глобальном объекте window
    if (consent === 'all' && !(window as any).GA_INITIALIZED) {
      (window as any).GA_INITIALIZED = true; 
      activateAnalytics();
    }
  }, []);

  const [filters, setFilters] = useState({ 
    technology: searchParams.getAll('technology'),
    voltage: searchParams.getAll('voltage'), 
    ipRating: searchParams.getAll('ipRating'),
    colorTemperature: searchParams.getAll('colorTemperature'),
    powerPerMeter: searchParams.getAll('powerPerMeter'),
    length: searchParams.getAll('length')
  });

  useEffect(() => {
    const newFilters = {
      technology: searchParams.getAll('technology'),
      voltage: searchParams.getAll('voltage'),
      ipRating: searchParams.getAll('ipRating'),
      colorTemperature: searchParams.getAll('colorTemperature'),
      powerPerMeter: searchParams.getAll('powerPerMeter'),
      length: searchParams.getAll('length')
    };
    setFilters(newFilters);
  }, [searchParams]);

  const translations = TRANSLATIONS[language];

  // Route detection for legal pages
  useEffect(() => {
    const path = window.location.pathname;
    if (path === '/terms') navigate('/terms');
    else if (path === '/privacy') navigate('/privacy');
    else if (path === '/returns') navigate('/returns');
  }, []);

  // Scroll to top on page change
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [window.location.pathname]);

  useEffect(() => {
    const loadData = async () => {
      // Use searchParams for server-side filtering
      const params = new URLSearchParams(searchParams);
      if (searchQuery) params.set('q', searchQuery);
      params.set('includeFacets', 'true');
      
      try {
        const result = await storeService.getProducts(params.toString());
        let resultProducts: Product[] = [];
        
        if (Array.isArray(result)) {
          resultProducts = result;
          setProducts(result);
        } else {
          resultProducts = result.products;
          setProducts(result.products);
          setServerFacets(result.facets);
        }
        
        const storedUser = storeService.getStoredUser();
        if (storedUser) {
          const latestUser = await storeService.getUser(storedUser.id);
          if (latestUser) {
            setCurrentUser(latestUser);
            storeService.updateUser(latestUser);
            // Sync cart on load if logged in
            await storeService.syncCart();
          } else {
            setCurrentUser(storedUser);
          }
          
          const wishlistIds = await storeService.getWishlist(storedUser.id);
          setWishlist(wishlistIds);
        }

        // Load cart
        const cartData = await storeService.getCart(storedUser?.id);
        
        let allProducts = resultProducts;
        if (!storedUser && cartData.length > 0 && params.toString() !== 'includeFacets=true') {
          try {
            const allRes = await storeService.getProducts('');
            allProducts = Array.isArray(allRes) ? allRes : allRes.products;
          } catch (e) {
            console.error("Error fetching all products for cart hydration", e);
          }
        }
        
        // Map server cart items to frontend CartItem type if needed
        const mappedCart = cartData.map((item: any) => {
          // If it's a server item (has .product)
          if (item.product) {
            return {
              ...item.product,
              quantity: item.quantity,
              images: JSON.parse(item.product.images || '[]'),
              title: {
                LV: item.product.titleLV,
                RU: item.product.titleRU,
                EN: item.product.titleEN
              }
            };
          }
          
          // If it's a guest item (only has productId and quantity)
          // Hydrate it from the products list
          const product = allProducts.find(p => p.id === item.productId);
          if (product) {
            return {
              ...product,
              quantity: item.quantity
            };
          }
          
          return null;
        }).filter(Boolean);
        setCart(mappedCart);
      } catch (error) {
        console.error("Failed to load initial data:", error);
      }
    };
    
    // Debounce search query changes
    const timer = setTimeout(() => {
      loadData();
    }, 300);
    
    window.addEventListener('rokof_data_updated', loadData);
    window.addEventListener('rokof_cart_updated', loadData);
    window.addEventListener('rokof_wishlist_updated', async () => {
      if (currentUser) {
        const wishlistIds = await storeService.getWishlist(currentUser.id);
        setWishlist(wishlistIds);
      }
    });
    
    return () => {
      clearTimeout(timer);
      window.removeEventListener('rokof_data_updated', loadData);
      window.removeEventListener('rokof_cart_updated', loadData);
    };
  }, [currentUser?.id, searchParams, searchQuery]);

  const handleLogout = () => {
    setCurrentUser(null);
    setWishlist([]);
    localStorage.removeItem('rokof_current_user_v1');
    navigate('/');
  };

  const handleLoginSuccess = async (u: User) => {
    setCurrentUser(u);
    storeService.updateUser(u);
    setIsAuthOpen(false);
    await storeService.syncCart();
    
    const toastId = Math.random().toString(36).substring(2, 9);
    setToasts(prev => [...prev, { id: toastId, message: translations.loginSuccess || 'Login successful' }]);
    
    if (localStorage.getItem('freshRegistration') === 'true') {
      navigate('/profile/settings');
    }
  };

  const handleUpdateUser = (updatedUser: User) => {
    setCurrentUser(updatedUser);
    storeService.updateUser(updatedUser);
    
    const toastId = Math.random().toString(36).substring(2, 9);
    setToasts(prev => [...prev, { id: toastId, message: translations.profileUpdated || 'Profile updated' }]);
  };

  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const addToCart = async (product: Product, quantity: number) => {
    if (quantity > product.stockQuantity) {
      const toastId = Math.random().toString(36).substring(2, 9);
      setToasts(prev => [...prev, { 
        id: toastId, 
        message: t('cart_notifications.not_enough_stock', { count: product.stockQuantity } as any) as string
      }]);
      return;
    }

    await storeService.addToCart(currentUser?.id, product.id, quantity);
    
    const toastId = Math.random().toString(36).substring(2, 9);
    const msg = t('cart_notifications.item_added');
    setToasts(prev => [...prev, { id: toastId, message: msg as string }]);
  };

  const toggleWishlist = async (productId: string) => {
    if (!currentUser) {
      handleOpenAuth('login');
      return;
    }
    
    const exists = wishlist.includes(productId);
    
    try {
      if (exists) {
        await storeService.removeFromWishlist(currentUser.id, productId);
        setWishlist(prev => prev.filter(id => id !== productId));
      } else {
        await storeService.addToWishlist(currentUser.id, productId);
        setWishlist(prev => [...prev, productId]);
      }

      const toastId = Math.random().toString(36).substring(2, 9);
      setToasts(prev => [...prev, { 
        id: toastId, 
        message: exists ? translations.removedFromWishlist : translations.addedToWishlist 
      }]);
    } catch (error) {
      console.error('Failed to toggle wishlist:', error);
    }
  };

  const removeFromCart = async (id: string) => {
    await storeService.removeFromCart(currentUser?.id, id);
  };

  // Use the extracted logic
  const {
    totalMeters,
    volumeDiscountRate,
    rawSubtotalNet,
    volumeDiscountValueNet,
    subtotalNet,
    vatValue,
    totalGross
  } = useMemo(() => calculateTotals(cart, currentUser), [cart, currentUser]);

  const toggleFilter = (key: 'technology' | 'voltage' | 'ipRating' | 'colorTemperature' | 'powerPerMeter' | 'length', value: string) => {
    const currentParams = new URLSearchParams(searchParams);
    const currentValues = currentParams.getAll(key);
    
    if (currentValues.includes(value)) {
      const newValues = currentValues.filter(v => v !== value);
      currentParams.delete(key);
      newValues.forEach(v => currentParams.append(key, v));
    } else {
      currentParams.append(key, value);
    }
    
    setSearchParams(currentParams);
  };

  const resetFilters = () => {
    setSearchParams(new URLSearchParams());
  };

  const handleOpenAuth = (mode: 'login' | 'signup' = 'login', type: 'INDIVIDUAL' | 'BUSINESS' = 'INDIVIDUAL') => {
    setAuthMode(mode);
    setAuthType(type);
    setIsAuthOpen(true);
  };

  const { facets, filteredProducts } = useMemo(() => {
    // 1. Calculate Facets from ALL products (or from current results if you want dependent facets)
    // Usually, faceted search shows all available options in the catalog
    const allFacets = {
      technology: new Map<string, number>(),
      voltage: new Map<string, number>(),
      ipRating: new Map<string, number>(),
      colorTemp: new Map<string, number>(),
      power: new Map<string, number>(),
      length: new Map<string, number>()
    };

    if (serverFacets && serverFacets.specifications) {
      const sSpecs = serverFacets.specifications;
      if (sSpecs.technology) Object.entries(sSpecs.technology).forEach(([v, c]) => allFacets.technology.set(v, c as number));
      if (sSpecs.voltage) Object.entries(sSpecs.voltage).forEach(([v, c]) => allFacets.voltage.set(v, c as number));
      if (sSpecs.ipRating) Object.entries(sSpecs.ipRating).forEach(([v, c]) => allFacets.ipRating.set(v, c as number));
      if (sSpecs.colorTemperature) Object.entries(sSpecs.colorTemperature).forEach(([v, c]) => allFacets.colorTemp.set(v, c as number));
      if (sSpecs.powerPerMeter) Object.entries(sSpecs.powerPerMeter).forEach(([v, c]) => allFacets.power.set(`${v}W`, c as number));
      if (sSpecs.length) Object.entries(sSpecs.length).forEach(([v, c]) => allFacets.length.set(`${v}m`, c as number));
    } else {
      products.forEach(p => {
        const specs = p.specifications || {};
        if (specs.technology) allFacets.technology.set(specs.technology, (allFacets.technology.get(specs.technology) || 0) + 1);
        if (specs.voltage) allFacets.voltage.set(specs.voltage, (allFacets.voltage.get(specs.voltage) || 0) + 1);
        if (specs.ipRating) allFacets.ipRating.set(specs.ipRating, (allFacets.ipRating.get(specs.ipRating) || 0) + 1);
        if (specs.colorTemperature) allFacets.colorTemp.set(specs.colorTemperature, (allFacets.colorTemp.get(specs.colorTemperature) || 0) + 1);
        if (specs.powerPerMeter) {
          const pVal = `${specs.powerPerMeter}W`;
          allFacets.power.set(pVal, (allFacets.power.get(pVal) || 0) + 1);
        }
        if (specs.length) {
          const lVal = `${specs.length}m`;
          allFacets.length.set(lVal, (allFacets.length.get(lVal) || 0) + 1);
        }
      });
    }

    // 2. Filter products (redundant if server filtered, but good for search query)
    const filtered = products.filter(p => {
      const title = p.title?.[language] || '';
      const sku = p.sku || '';
      const specs = p.specifications || {};
      
      const matchesSearch = title.toLowerCase().includes(searchQuery.toLowerCase()) || 
                            sku.toLowerCase().includes(searchQuery.toLowerCase());
      
      // Client-side filtering as fallback or for search
      const matchesTechnology = filters.technology.length === 0 || 
                                (specs.technology && filters.technology.map(f => f.toUpperCase()).includes(specs.technology.toUpperCase()));
      
      const matchesVoltage = filters.voltage.length === 0 || 
                             (specs.voltage && filters.voltage.includes(specs.voltage));
      
      const matchesIP = filters.ipRating.length === 0 || 
                        (specs.ipRating && filters.ipRating.includes(specs.ipRating));
      
      const matchesColor = filters.colorTemperature.length === 0 || 
                           (specs.colorTemperature && filters.colorTemperature.includes(specs.colorTemperature));

      const matchesPower = filters.powerPerMeter.length === 0 || 
                           (specs.powerPerMeter && filters.powerPerMeter.includes(`${specs.powerPerMeter}W`));

      const matchesLength = filters.length.length === 0 || 
                            (specs.length && filters.length.includes(`${specs.length}m`));
      
      return matchesSearch && matchesTechnology && matchesVoltage && matchesIP && matchesColor && matchesPower && matchesLength;
    });

    return { facets: allFacets, filteredProducts: filtered };
  }, [products, serverFacets, searchQuery, filters, language]);

  useEffect(() => {
    if (window.location.pathname === '/profile/settings' && !currentUser) {
      navigate('/');
      handleOpenAuth('login');
    }
  }, [window.location.pathname, currentUser]);

  const renderServicePage = (type: 'distanceContract' | 'privacyPolicy' | 'deliveryPayment' | 'returnsPolicy' | 'faq') => {
    const data = translations.legalPages[type];
    const sectionTitle = translations.footer.legal; // "JURIDISKĀ INFORMĀCIJA"
    const icons = {
      distanceContract: FileText,
      privacyPolicy: Shield,
      deliveryPayment: CreditCard,
      returnsPolicy: RefreshCcw,
      faq: FileText
    };
    const Icon = icons[type];

    return (
      <div className="max-w-4xl mx-auto py-20 animate-in fade-in slide-in-from-bottom-4 duration-700">
        <div className="mb-12 flex flex-col items-center text-center">
          <span className="text-[10px] font-black uppercase tracking-[0.5em] text-[#8DB835] mb-4">{sectionTitle}</span>
          <div className="w-16 h-16 bg-zinc-100 flex items-center justify-center text-black mb-6 border border-zinc-200">
            <Icon size={32} />
          </div>
          <h1 className="text-3xl md:text-4xl font-black uppercase tracking-tight mb-4">{data.title}</h1>
          <div className="w-20 h-1 bg-black"></div>
        </div>
        <div className="bg-white border-2 border-black p-10 md:p-16 shadow-[20px_20px_0px_rgba(0,0,0,0.05)]">
          <div className="prose prose-zinc max-w-none">
            {data.content.split('\n').map((line, i) => {
              const isHeader = 
                line.match(/^\d\./) || 
                line.includes('ROKOF —') || 
                line.match(/^[💳🚚🎁🛡️🏢]/) ||
                (line.match(/^[A-ZŠŽČĀĒĪŪĶĻŅ\s\(\)]+[:]?$/) && !line.match(/[0-9]/));

              return (
                <p key={`line-${i}`} className={`text-zinc-600 text-sm font-bold leading-loose ${isHeader ? 'text-black font-black mt-8 text-base' : ''}`}>
                  {line}
                </p>
              );
            })}
            {type === 'privacyPolicy' && <PrivacyAgeSection />}
          </div>
        </div>
        <div className="mt-12 flex justify-center">
          <button 
            onClick={() => navigate('/')}
            className="px-10 py-5 bg-black text-white text-[11px] font-black uppercase tracking-[0.3em] flex items-center gap-4 hover:bg-zinc-800 transition-all"
          >
            {translations.backToStore} <ArrowRight size={18} />
          </button>
        </div>
      </div>
    );
  };

  const filterHeaderClass = "text-[10px] font-medium uppercase text-[#8DB835] tracking-wider mb-2";

  return (
    <div className="min-h-screen flex flex-col bg-[#F8F9FA] text-black">
        <Header 
          cartCount={cart.reduce((acc, item) => acc + item.quantity, 0)}
          onOpenCart={() => setIsCartOpen(true)}
          language={language}
          setLanguage={setLanguage}
          isB2B={currentUser?.type === 'BUSINESS'}
          setIsB2B={() => {}}
          onSearch={setSearchQuery}
          user={currentUser}
          onOpenAuth={handleOpenAuth}
          onLogout={handleLogout}
          onAdminOpen={() => setIsAdminOpen(true)}
        />

        <main className="pt-24 pb-20 max-w-[1920px] mx-auto px-6 xl:px-10 flex-grow w-full">
          <Routes>
            <Route path="/" element={(
              <div className="flex flex-col lg:flex-row gap-x-4 w-full">
                <aside className="w-full lg:w-[180px] shrink-0 lg:sticky lg:top-28 lg:h-[calc(100vh-10rem)] overflow-y-auto no-scrollbar space-y-8 pr-1 py-2">
                  <div className="flex items-center justify-between border-b pb-3 mb-6">
                    <h4 className="text-[10px] font-black uppercase tracking-widest flex items-center gap-1.5"><SlidersHorizontal size={12}/> {translations.filters}</h4>
                    <button 
                      onClick={resetFilters} 
                      aria-label={translations.filterReset}
                      className="text-[8px] font-black text-rose-500 hover:text-rose-700 uppercase tracking-widest transition-colors focus:outline-none focus:underline"
                    >{translations.filterReset}</button>
                  </div>
                  
                  <div className="space-y-6">
                    <div className="space-y-1">
                      <div className={filterHeaderClass}>{translations.technology}</div>
                      <div className="flex flex-col">
                        {Array.from(facets.technology.entries()).sort().map(([v, count], idx) => (
                          <button 
                            key={v || `tech-${idx}`} 
                            onClick={() => toggleFilter('technology', v)} 
                            aria-label={`Filter by technology: ${v}`}
                            aria-pressed={filters.technology.includes(v)}
                            className={`w-full py-1 text-left text-sm font-bold transition-all flex items-center justify-between group focus:outline-none ${filters.technology.includes(v) ? 'text-[#8DB835]' : 'text-zinc-500 hover:text-black'}`}
                          >
                            <div className="flex items-center gap-2">
                              <div className={`w-1.5 h-1.5 rounded-full ${filters.technology.includes(v) ? 'bg-[#8DB835]' : 'bg-transparent border border-zinc-200'}`}></div>
                              {v}
                            </div>
                            <span className="text-[9px] text-zinc-300 font-bold group-hover:text-zinc-400">{count}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    
                    <div className="space-y-1">
                      <div className={filterHeaderClass}>{translations.voltage}</div>
                      <div className="flex flex-col">
                        {Array.from(facets.voltage.entries()).sort().map(([v, count], idx) => (
                          <button 
                            key={v || `voltage-${idx}`} 
                            onClick={() => toggleFilter('voltage', v)} 
                            aria-label={`Filter by voltage: ${v}`}
                            aria-pressed={filters.voltage.includes(v)}
                            className={`w-full py-1 text-left text-sm font-bold transition-all flex items-center justify-between group focus:outline-none ${filters.voltage.includes(v) ? 'text-[#8DB835]' : 'text-zinc-500 hover:text-black'}`}
                          >
                            <div className="flex items-center gap-2">
                              <div className={`w-1.5 h-1.5 rounded-full ${filters.voltage.includes(v) ? 'bg-[#8DB835]' : 'bg-transparent border border-zinc-200'}`}></div>
                              {v}
                            </div>
                            <span className="text-[9px] text-zinc-300 font-bold group-hover:text-zinc-400">{count}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className={filterHeaderClass}>{translations.ipRating}</div>
                      <div className="flex flex-col">
                        {Array.from(facets.ipRating.entries()).sort().map(([v, count], idx) => (
                          <button 
                            key={v || `ip-${idx}`} 
                            onClick={() => toggleFilter('ipRating', v)} 
                            aria-label={`Filter by IP rating: ${v}`}
                            aria-pressed={filters.ipRating.includes(v)}
                            className={`w-full py-1 text-left text-sm font-bold transition-all flex items-center justify-between group focus:outline-none ${filters.ipRating.includes(v) ? 'text-[#8DB835]' : 'text-zinc-500 hover:text-black'}`}
                          >
                            <div className="flex items-center gap-2">
                              <div className={`w-1.5 h-1.5 rounded-full ${filters.ipRating.includes(v) ? 'bg-[#8DB835]' : 'bg-transparent border border-zinc-200'}`}></div>
                              {v}
                            </div>
                            <span className="text-[9px] text-zinc-300 font-bold group-hover:text-zinc-400">{count}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className={filterHeaderClass}>{translations.colorTemp}</div>
                      <div className="flex flex-col">
                        {Array.from(facets.colorTemp.entries()).sort().map(([v, count], idx) => (
                          <button 
                            key={v || `color-${idx}`} 
                            onClick={() => toggleFilter('colorTemperature', v)} 
                            aria-label={`Filter by color temperature: ${v}`}
                            aria-pressed={filters.colorTemperature.includes(v)}
                            className={`w-full py-1 text-left text-sm font-bold transition-all flex items-center justify-between group focus:outline-none ${filters.colorTemperature.includes(v) ? 'text-[#8DB835]' : 'text-zinc-500 hover:text-black'}`}
                          >
                            <div className="flex items-center gap-2">
                              <div className={`w-1.5 h-1.5 rounded-full ${filters.colorTemperature.includes(v) ? 'bg-[#8DB835]' : 'bg-transparent border border-zinc-200'}`}></div>
                              {v}
                            </div>
                            <span className="text-[9px] text-zinc-300 font-bold group-hover:text-zinc-400">{count}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className={filterHeaderClass}>{translations.power}</div>
                      <div className="flex flex-col">
                        {Array.from(facets.power.entries()).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])).map(([v, count], idx) => (
                          <button 
                            key={v || `power-${idx}`} 
                            onClick={() => toggleFilter('powerPerMeter', v)} 
                            aria-label={`Filter by power: ${v}`}
                            aria-pressed={filters.powerPerMeter.includes(v)}
                            className={`w-full py-1 text-left text-sm font-bold transition-all flex items-center justify-between group focus:outline-none ${filters.powerPerMeter.includes(v) ? 'text-[#8DB835]' : 'text-zinc-500 hover:text-black'}`}
                          >
                            <div className="flex items-center gap-2">
                              <div className={`w-1.5 h-1.5 rounded-full ${filters.powerPerMeter.includes(v) ? 'bg-[#8DB835]' : 'bg-transparent border border-zinc-200'}`}></div>
                              {v}
                            </div>
                            <span className="text-[9px] text-zinc-300 font-bold group-hover:text-zinc-400">{count}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className={filterHeaderClass}>{translations.length}</div>
                      <div className="flex flex-col">
                        {Array.from(facets.length.entries()).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])).map(([v, count], idx) => (
                          <button 
                            key={v || `length-${idx}`} 
                            onClick={() => toggleFilter('length', v)} 
                            aria-label={`Filter by length: ${v}`}
                            aria-pressed={filters.length.includes(v)}
                            className={`w-full py-1 text-left text-sm font-bold transition-all flex items-center justify-between group focus:outline-none ${filters.length.includes(v) ? 'text-[#8DB835]' : 'text-zinc-500 hover:text-black'}`}
                          >
                            <div className="flex items-center gap-2">
                              <div className={`w-1.5 h-1.5 rounded-full ${filters.length.includes(v) ? 'bg-[#8DB835]' : 'bg-transparent border border-zinc-200'}`}></div>
                              {v}
                            </div>
                            <span className="text-[9px] text-zinc-300 font-bold group-hover:text-zinc-400">{count}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </aside>

                <div className="flex-grow">
                  <div className="flex items-center justify-between mb-8 border-b pb-6">
                    <div className="text-[10px] font-black uppercase tracking-widest text-zinc-400">{filteredProducts.length} {translations.results}</div>
                    <div className="flex gap-2 bg-white p-1 border shadow-sm rounded-sm">
                      <button 
                        onClick={() => setViewLayout('list')} 
                        aria-label="List View"
                        aria-pressed={viewLayout === 'list'}
                        className={`p-2 transition-colors focus:outline-none focus:ring-2 focus:ring-black ${viewLayout === 'list' ? 'bg-black text-white' : 'text-zinc-300 hover:text-black'}`}
                      ><List size={18} /></button>
                      <button 
                        onClick={() => setViewLayout('grid')} 
                        aria-label="Grid View"
                        aria-pressed={viewLayout === 'grid'}
                        className={`p-2 transition-colors focus:outline-none focus:ring-2 focus:ring-black ${viewLayout === 'grid' ? 'bg-black text-white' : 'text-zinc-300 hover:text-black'}`}
                      ><LayoutGrid size={18} /></button>
                    </div>
                  </div>

                  <ErrorBoundary>
                    {filteredProducts.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-32 bg-white border border-dashed border-zinc-200">
                        <SearchX size={48} className="text-zinc-100 mb-6" />
                        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-zinc-300 mb-8">No matching items found</p>
                        <button 
                          onClick={() => { setSearchQuery(''); resetFilters(); }} 
                          className="px-8 py-4 bg-black text-white text-[10px] font-black uppercase tracking-widest"
                        >
                          Reset all filters
                        </button>
                      </div>
                    ) : viewLayout === 'list' ? (
                      <div className="bg-white border border-zinc-100 shadow-sm overflow-x-auto relative no-scrollbar">
                        <div className="min-w-[1000px] xl:min-w-full">
                          <div className="hidden md:flex items-center bg-white border-b border-gray-200 py-4 text-[10px] font-black uppercase tracking-[0.15em] text-zinc-500 sticky top-0 z-20 shadow-sm">
                            <div className="w-[6%] text-center shrink-0">{translations.headerPhoto}</div>
                            <div className="w-[44%] px-6 grow">{translations.headerSymbol}</div>
                            <div className="w-[16%] text-center shrink-0">{translations.headerAvailability}</div>
                            <div className="w-[14%] text-right pr-8 shrink-0">{translations.headerPrice}</div>
                            <div className="w-[20%] shrink-0"></div>
                          </div>
                          <div className="divide-y divide-zinc-50">
                            {filteredProducts.map((p, idx) => (
                              <ProductRow 
                                key={p.id || p.sku || `product-${idx}`} 
                                product={p} 
                                onAddToCart={addToCart} 
                                onViewDetails={(p) => { setSelectedProduct(p); navigate(`/product/${p.id}`); }} 
                                user={currentUser} 
                                language={language} 
                                isWishlisted={wishlist.includes(p.id)}
                                onToggleWishlist={() => toggleWishlist(p.id)}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-4 gap-6 xl:gap-8">
                        {filteredProducts.map((p, idx) => (
                          <ProductCard 
                            key={p.id || p.sku || `product-card-${idx}`} 
                            product={p} 
                            onAddToCart={addToCart} 
                            onViewDetails={(p) => { setSelectedProduct(p); navigate(`/product/${p.id}`); }} 
                            user={currentUser} 
                            language={language} 
                            isWishlisted={wishlist.includes(p.id)}
                            onToggleWishlist={() => toggleWishlist(p.id)}
                          />
                        ))}
                      </div>
                    )}
                  </ErrorBoundary>
                </div>
              </div>
            )} />
            <Route path="/product/:id" element={
              <ProductDetailRoute 
                products={products} 
                addToCart={addToCart} 
                language={language} 
                currentUser={currentUser} 
                wishlist={wishlist} 
                toggleWishlist={toggleWishlist} 
              />
            } />
            <Route path="/admin" element={<AdminPanel isOpen={true} onClose={() => navigate('/')} language={language} />} />
            <Route path="/admin/invoices/new" element={<InvoiceEditor />} />
            <Route path="/admin/invoices/:uuid" element={<InvoiceEditor />} />
            <Route path="/partners" element={<PartnersPage language={language} onOpenAuth={(mode, type) => handleOpenAuth(mode, type === 'B2B' ? 'BUSINESS' : 'INDIVIDUAL')} />} />
            <Route path="/contacts" element={<ContactsPage language={language} />} />
            <Route path="/terms" element={renderServicePage('distanceContract')} />
            <Route path="/privacy" element={renderServicePage('privacyPolicy')} />
            <Route path="/delivery" element={renderServicePage('deliveryPayment')} />
            <Route path="/returns" element={renderServicePage('returnsPolicy')} />
            <Route path="/faq" element={renderServicePage('faq')} />
            <Route path="/forgot-password" element={<ForgotPassword language={language} />} />
            <Route path="/reset-password" element={<ResetPassword language={language} />} />
            <Route path="/profile/settings" element={currentUser ? (
              <UserDashboard 
                user={currentUser} 
                language={language} 
                cart={cart} 
                onLogout={handleLogout}
                onUpdateUser={handleUpdateUser}
                onAddToCart={addToCart}
                onToggleWishlist={toggleWishlist}
                onViewDetails={(p) => { setSelectedProduct(p); navigate(`/product/${p.id}`); }} 
              />
            ) : (
              <div className="py-20 text-center">
                <p className="text-[10px] font-black uppercase tracking-widest text-zinc-300">Please log in to view your profile settings.</p>
                <button onClick={() => handleOpenAuth('login')} className="mt-4 px-6 py-3 bg-black text-white text-[10px] font-black uppercase tracking-widest">Login</button>
              </div>
            )} />
          </Routes>
        </main>

        <Footer language={language} />

        {/* Cart Sidebar */}
        {isCartOpen && (
          <div className="fixed inset-0 z-[150] flex justify-end">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setIsCartOpen(false)} />
            <div className="relative w-full max-w-md bg-white h-full flex flex-col shadow-2xl animate-in slide-in-from-right duration-300">
              <div className="p-8 bg-black text-white flex items-center justify-between shrink-0">
                <h2 className="text-xl font-black uppercase tracking-tight">{translations.cart}</h2>
                <button 
                  onClick={() => setIsCartOpen(false)} 
                  aria-label="Close Cart"
                  className="p-2 hover:bg-zinc-800 transition-colors focus:outline-none focus:ring-2 focus:ring-white"
                ><X size={32} /></button>
              </div>
              
              <div className="flex-grow overflow-y-auto p-8 space-y-6">
                {cart.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-zinc-200">
                    <ShoppingCart size={48} strokeWidth={1} />
                    <p className="mt-4 text-[10px] font-black uppercase tracking-widest">{translations.cartEmpty}</p>
                  </div>
                ) : (
                  <>
                    {/* VOLUME DISCOUNT UPSELL BANNER (B2C Only) */}
                    {(!currentUser || currentUser.type === 'INDIVIDUAL') && (
                      <>
                        {totalMeters < 50 && (
                          <div className="p-5 bg-white border-2 border-[#8DB835] border-dashed flex items-center gap-4 animate-pulse">
                            <Percent className="text-[#8DB835] shrink-0" size={24} />
                            <p className="text-[11px] font-black uppercase leading-tight">
                              {translations.volumeDiscountUpsell.replace('{m}', (50 - totalMeters).toString()).replace('{p}', '5')}
                            </p>
                          </div>
                        )}
                        {totalMeters >= 50 && totalMeters < 100 && (
                          <div className="p-5 bg-white border-2 border-[#8DB835] border-dashed flex items-center gap-4 animate-pulse">
                            <Percent className="text-[#8DB835] shrink-0" size={24} />
                            <p className="text-[11px] font-black uppercase leading-tight">
                              {translations.volumeDiscountUpsell.replace('{m}', (100 - totalMeters).toString()).replace('{p}', '10')}
                            </p>
                          </div>
                        )}
                      </>
                    )}

                    {/* Progress banner shown only for B2B users */}
                    {currentUser?.type === 'BUSINESS' && totalGross < FREE_DELIVERY_LIMIT && (
                      <div className="p-4 bg-[#F9F4E8] border border-dashed border-[#8DB835] flex items-center gap-4">
                        <Truck className="text-[#8DB835]" size={20} />
                        <div className="flex flex-col">
                          <span className="text-[10px] font-black uppercase tracking-widest text-zinc-500">{translations.freeDelivery}</span>
                          <span className="text-[11px] font-black uppercase">
                            {t('shipping_messages.free_shipping_bonus', { amount: (FREE_DELIVERY_LIMIT - totalGross).toFixed(2) })}
                          </span>
                        </div>
                      </div>
                    )}
                    
                    {cart.map((item, idx) => {
                      const itemPrice = getPersonalizedPrice(item.price, item.b2bPrice, currentUser);
                      return (
                        <div key={item.id || item.sku || `cart-item-${idx}`} className="flex gap-4 border-b border-zinc-50 pb-4 items-center">
                          <div className="w-16 h-16 bg-zinc-50 border shrink-0 overflow-hidden"><img src={item.images?.[0] || 'https://picsum.photos/seed/rokof/800/600'} className="w-full h-full object-cover" alt={item.sku} /></div>
                          <div className="flex-grow">
                            <h4 className="text-[10px] font-black uppercase tracking-tight line-clamp-2">{item.title?.[language] || ''}</h4>
                            <div className="flex justify-between mt-2 items-center">
                              <span className="text-[10px] font-bold text-zinc-400">{item.quantity}{item.unit}</span>
                              <span className="text-sm font-black text-black">€{(itemPrice * item.quantity).toFixed(2)}</span>
                            </div>
                          </div>
                          <button 
                            onClick={() => removeFromCart(item.id)} 
                            aria-label={`Remove ${item.title?.[language] || 'item'} from cart`}
                            className="p-2 text-zinc-200 hover:text-rose-500 transition-colors focus:outline-none focus:text-rose-500"
                          ><Trash2 size={14} /></button>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>

              {cart.length > 0 && (
                <div className="p-8 bg-zinc-50 border-t border-zinc-100 space-y-4">
                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px] font-bold text-zinc-400 uppercase tracking-widest"><span>{translations.subtotal}</span><span>€{rawSubtotalNet.toFixed(2)}</span></div>
                    {volumeDiscountRate > 0 && (
                      <div className="flex justify-between text-[10px] font-black text-[#8DB835] uppercase tracking-widest">
                        <span>{translations.volumeDiscountLabel.replace('{m}', totalMeters.toString())}</span>
                        <span>-€{volumeDiscountValueNet.toFixed(2)} (-{volumeDiscountRate}%)</span>
                      </div>
                    )}
                    <div className="flex justify-between text-[10px] font-bold text-zinc-400 uppercase tracking-widest pt-2 border-t border-zinc-200"><span>{translations.discountedSubtotal}</span><span>€{subtotalNet.toFixed(2)}</span></div>
                    <div className="flex justify-between text-[10px] font-bold text-zinc-400 uppercase tracking-widest"><span>{translations.vatAmount}</span><span>€{vatValue.toFixed(2)}</span></div>
                  </div>
                  <div className="flex justify-between items-center py-4 border-t border-zinc-200">
                    <span className="text-[12px] font-black uppercase tracking-widest">{translations.total}</span>
                    <span className="text-3xl font-black tracking-tighter text-black">€{totalGross.toFixed(2)}</span>
                  </div>
                  <button 
                    onClick={() => { setIsCartOpen(false); setIsCheckoutOpen(true); }} 
                    aria-label={translations.checkout}
                    className="w-full py-5 bg-black text-white text-[10px] font-black uppercase tracking-[0.2em] flex items-center justify-center gap-3 hover:bg-zinc-800 transition-all shadow-xl focus:outline-none focus:ring-2 focus:ring-black"
                  >
                    {translations.checkout} <ArrowRight size={18} />
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Toast Notifications */}
        <div className="fixed bottom-10 right-10 z-[200] flex flex-col gap-3 pointer-events-none">
          {toasts.map(toast => (
            <Toast key={toast.id} id={toast.id} message={toast.message} onClose={removeToast} />
          ))}
        </div>

        <ErrorBoundary>
          <AuthModal 
            isOpen={isAuthOpen} 
            onClose={() => setIsAuthOpen(false)} 
            language={language} 
            onLoginSuccess={handleLoginSuccess} 
            initialMode={authMode}
            initialType={authType}
          />
        </ErrorBoundary>
        <CheckoutModal isOpen={isCheckoutOpen} onClose={() => setIsCheckoutOpen(false)} language={language} cart={cart} user={currentUser} onSuccess={() => { setCart([]); setIsCheckoutOpen(false); }} onUpdateUser={handleUpdateUser} />
        <AdminPanel isOpen={isAdminOpen} onClose={() => setIsAdminOpen(false)} language={language} />
        <CookieBanner onOpenPrivacy={() => navigate('/privacy')} />
      </div>
  );
};

const App: React.FC = () => {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
};

export default App;
