
import { PrismaClient } from '@prisma/client';
import fetch from 'node-fetch';

const prisma = new PrismaClient();
const API_URL = 'http://localhost:3000';
const USER_ID = '9548cc14-e317-4756-b1db-a6964ced3554';
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI5NTQ4Y2MxNC1lMzE3LTQ3NTYtYjFkYi1hNjk2NGNlZDM1NTQiLCJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20iLCJyb2xlIjoiQ1VTVE9NRVIiLCJpYXQiOjE3NzM5MTUxMjV9.nTNWEStO44YIPgRPwysqKnwfOhFIuhgHcdQiQTFEbrk';

async function test() {
  const product = await prisma.product.findFirst({
    where: { stockQuantity: { gt: 20 } }
  });

  if (!product) {
    console.error("No product found with stock > 20");
    return;
  }

  console.log(`Testing with product: ${product.sku}, Initial stock: ${product.stockQuantity}`);
  const initialStock = product.stockQuantity;

  // 1. Guest Checkout
  console.log("\n--- Guest Checkout Test ---");
  const guestOrderData = {
    userId: 'guest',
    items: [{ id: product.id, sku: product.sku, quantity: 2, price: product.price }],
    deliveryCost: 5,
    deliveryMethod: 'COURIER',
    shippingAddress: 'Guest Address',
    customerInfo: { name: 'Guest User', email: 'guest@example.com', phone: '00000000' },
    language: 'LV',
    country: 'LV'
  };

  const guestRes = await fetch(`${API_URL}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(guestOrderData)
  });

  if (guestRes.ok) {
    console.log(`Guest order created`);
    const updatedProduct = await prisma.product.findUnique({ where: { id: product.id } });
    console.log(`Stock after guest checkout: ${updatedProduct.stockQuantity} (Expected: ${initialStock - 2})`);
  } else {
    console.error("Guest checkout failed:", await guestRes.text());
  }

  // 2. User Add to Cart
  console.log("\n--- User Add to Cart Test ---");
  const stockBeforeUser = (await prisma.product.findUnique({ where: { id: product.id } })).stockQuantity;
  const cartRes = await fetch(`${API_URL}/api/users/${USER_ID}/cart`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify({ productId: product.id, quantity: 5 })
  });

  if (cartRes.ok) {
    console.log("User added 5 items to cart");
    const updatedProduct = await prisma.product.findUnique({ where: { id: product.id } });
    console.log(`Stock after user add to cart: ${updatedProduct.stockQuantity} (Expected: ${stockBeforeUser - 5})`);
    
    // Verify cart content via GET
    const getCartRes = await fetch(`${API_URL}/api/users/${USER_ID}/cart`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` }
    });
    if (getCartRes.ok) {
      const cart = await getCartRes.json();
      const item = cart.find((i: any) => i.productId === product.id);
      console.log(`Cart item quantity: ${item?.quantity} (Expected: 5)`);
    }
  } else {
    console.error("User add to cart failed:", await cartRes.text());
  }

  // 3. User Update Cart (Decrease)
  console.log("\n--- User Update Cart (Decrease) Test ---");
  const stockBeforeUpdate = (await prisma.product.findUnique({ where: { id: product.id } })).stockQuantity;
  const updateRes = await fetch(`${API_URL}/api/users/${USER_ID}/cart`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify({ productId: product.id, quantity: -2 }) // Decrease by 2
  });

  if (updateRes.ok) {
    console.log("User decreased cart quantity by 2 (Now 3 in cart)");
    const updatedProduct = await prisma.product.findUnique({ where: { id: product.id } });
    console.log(`Stock after decrease: ${updatedProduct.stockQuantity} (Expected: ${stockBeforeUpdate + 2})`);
  } else {
    console.error("User update cart failed:", await updateRes.text());
  }

  // 4. User Checkout
  console.log("\n--- User Checkout Test ---");
  const stockBeforeCheckout = (await prisma.product.findUnique({ where: { id: product.id } })).stockQuantity;
  const userOrderData = {
    userId: USER_ID,
    items: [{ id: product.id, sku: product.sku, quantity: 3, price: product.price }],
    deliveryCost: 0,
    deliveryMethod: 'PICKUP',
    shippingAddress: 'User Address',
    customerInfo: { name: 'Test User', email: 'test@example.com', phone: '12345678' },
    language: 'LV',
    country: 'LV'
  };

  const userOrderRes = await fetch(`${API_URL}/api/orders`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify(userOrderData)
  });

  if (userOrderRes.ok) {
    console.log(`User order created`);
    const updatedProduct = await prisma.product.findUnique({ where: { id: product.id } });
    // Stock should NOT change because it was already decremented when added to cart
    console.log(`Stock after user checkout: ${updatedProduct.stockQuantity} (Expected: ${stockBeforeCheckout})`);
  } else {
    console.error("User checkout failed:", await userOrderRes.text());
  }

  // 5. User Remove from Cart (Add again first)
  console.log("\n--- User Remove from Cart Test ---");
  const addRes = await fetch(`${API_URL}/api/users/${USER_ID}/cart`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify({ productId: product.id, quantity: 4 })
  });
  
  if (!addRes.ok) {
    console.error("Add to cart before remove failed:", await addRes.text());
  } else {
    console.log("Added 4 items to cart for removal test");
  }
  
  const stockBeforeRemove = (await prisma.product.findUnique({ where: { id: product.id } })).stockQuantity;
  console.log(`Stock before remove: ${stockBeforeRemove}`);
  
  const removeRes = await fetch(`${API_URL}/api/users/${USER_ID}/cart/${product.id}`, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + TOKEN }
  });

  if (removeRes.ok) {
    console.log("User removed items from cart");
    const updatedProduct = await prisma.product.findUnique({ where: { id: product.id } });
    console.log(`Stock after remove: ${updatedProduct.stockQuantity} (Expected: ${stockBeforeRemove + 4})`);
  } else {
    console.error("User remove from cart failed:", await removeRes.text());
  }
}

test().finally(() => prisma.$disconnect());
