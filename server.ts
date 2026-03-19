import express from "express";
import * as dotenv from "dotenv";
dotenv.config();

import { createServer as createViteServer } from "vite";
import multer from "multer";
import * as xlsx from "xlsx";
import { PrismaClient, Prisma } from "@prisma/client";
import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
import QRCode from "qrcode";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { createRequire } from 'module';
import Redis from "ioredis";
import Redlock from "redlock";
import Stripe from "stripe";

const require = createRequire(import.meta.url);
import invoiceRouter, { createInvoiceFromOrder, mapInvoice } from "./server/invoices";
import { generateInvoicePdfData } from "./server/pdfUtils";

import { TRANSLATIONS } from "./constants";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { sendWelcomeEmail } from "./src/services/emailService";

import { COMPANY_DETAILS } from "./server/config";

if (!process.env.JWT_SECRET) {
  console.error("FATAL ERROR: JWT_SECRET is not defined.");
  process.exit(1);
}

const prisma = new PrismaClient();
const ADMIN_EMAIL = process.env.SMTP_FROM || 'pavels@pzka.lv';
const upload = multer({ storage: multer.memoryStorage() });

// Redis & Redlock for Distributed Inventory Locking
let redis: any;
let redisSubscriber: any;

if (process.env.REDIS_URL) {
  const redisOptions = {
    maxRetriesPerRequest: 20,
    retryStrategy: (times: number) => Math.min(times * 50, 2000),
  };
  redis = new Redis(process.env.REDIS_URL, redisOptions);
  redisSubscriber = new Redis(process.env.REDIS_URL, redisOptions);
} else {
  // Fallback to ioredis-mock for local development without Redis
  try {
    const RedisMock = require('ioredis-mock');
    redis = new RedisMock();
    redisSubscriber = new RedisMock();
    // Mock config method for ioredis-mock
    redis.config = async () => 'OK';
  } catch (e) {
    // Last resort fallback
    const fallbackOptions = { maxRetriesPerRequest: 1, retryStrategy: () => null };
    redis = new Redis('redis://localhost:6379', fallbackOptions);
    redisSubscriber = new Redis('redis://localhost:6379', fallbackOptions);
  }
}

// Handle errors to prevent unhandled error events and crashes
const handleRedisError = (err: any, label: string) => {
  if (!process.env.REDIS_URL && err.code === 'ECONNREFUSED') {
    // Silent in dev if no REDIS_URL
    return;
  }
  console.error(`[${label} Error]`, err);
};

redis.on('error', (err: any) => handleRedisError(err, 'Redis'));
redisSubscriber.on('error', (err: any) => handleRedisError(err, 'Redis Subscriber'));

const redlock = new Redlock([redis], {
  driftFactor: 0.01,
  retryCount: 10,
  retryDelay: 200,
  retryJitter: 200,
  automaticExtensionThreshold: 500,
});

// Setup Keyspace Notifications for Reservations
redis.config('SET', 'notify-keyspace-events', 'Ex').catch(console.error);

redisSubscriber.subscribe('__keyevent@0__:expired', (err: any) => {
  if (err) {
    if (!process.env.REDIS_URL && err.name === 'MaxRetriesPerRequestError') {
      // Ignore in dev if no REDIS_URL
      return;
    }
    console.error("Failed to subscribe to expired events:", err);
  }
});

redisSubscriber.on('message', async (channel, message) => {
  if (channel === '__keyevent@0__:expired' && message.startsWith('reservation:')) {
    const parts = message.split(':');
    if (parts.length >= 4) {
      const productId = parts[2];
      const quantity = parseInt(parts[3], 10);
      
      try {
        const lock = await redlock.acquire([`lock:product:${productId}`], 5000);
        try {
          await prisma.product.update({
            where: { id: productId },
            data: { stockQuantity: { increment: quantity } }
          });
          console.log(`Restored ${quantity} stock for product ${productId} due to TTL expiration.`);
        } finally {
          await lock.release();
        }
      } catch (error) {
        console.error(`Failed to restore stock for product ${productId}:`, error);
      }
    }
  }
});

// Stripe for Payments
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_mock', {
  apiVersion: '2025-01-27.acacia' as any,
});

// Email Transporter Configuration
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendInDeliveryEmail(order: any) {
  if (!order?.user?.email) return;
  try {
    const orderIdStr = order.invoiceNumber || order.id;
    const customerName = order.user?.firstName || order.user?.name || "Klients";
    
    await transporter.sendMail({
      from: `"ROKOF" <${ADMIN_EMAIL}>`,
      to: order.user.email,
      subject: `Pasūtījums ${orderIdStr} ir nodots piegādei`,
      text: `Labdien / Здравствуйте, ${customerName}!

(LV): Informējam, ka Jūsu pasūtījums ${orderIdStr} ir nodots piegādei. Kurjers sazināsies ar Jums tuvākajā laikā.
(RU): Информируем Вас о том, что Ваш заказ ${orderIdStr} передан на доставку. Курьер свяжется с Вами в ближайшее время.

Ar cieņu / С уважением,
ROKOF.LV`
    });
  } catch (emailError) {
    console.error("Failed to send IN_DELIVERY email:", emailError);
  }
}

function generateOrderSummaryHtml(order: any) {
  const itemsHtml = order.items.map((item: any) => `
    <tr style="border-bottom: 1px solid #eee;">
      <td style="padding: 10px 0;">${item.title} (${item.sku})</td>
      <td style="padding: 10px 0; text-align: center;">${item.quantity}</td>
      <td style="padding: 10px 0; text-align: right;">€${Number(item.priceAtPurchase || item.price || 0).toFixed(2)}</td>
    </tr>
  `).join('');

  return `
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
      <thead>
        <tr style="border-bottom: 2px solid #000;">
          <th style="text-align: left; padding: 10px 0;">Prece</th>
          <th style="text-align: center; padding: 10px 0;">Daudz.</th>
          <th style="text-align: right; padding: 10px 0;">Cena</th>
        </tr>
      </thead>
      <tbody>
        ${itemsHtml}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="2" style="text-align: right; padding: 10px 0; font-weight: bold;">Kopā:</td>
          <td style="text-align: right; padding: 10px 0; font-weight: bold;">€${Number(order.totalAmount || 0).toFixed(2)}</td>
        </tr>
      </tfoot>
    </table>
  `;
}

function generateProfessionalEmailHtml(title: string, content: string, recipientName: string, email: string, loginUrl: string, language: string, orderSummary?: string) {
  const isLV = language === 'lv';
  const loginText = isLV ? 'Pieslēgties profilam' : 'Login to your profile';
  const privacyText = isLV ? 'Privātuma politiku' : 'Privacy Policy';
  const contactText = isLV ? 'Ja Jums rodas jautājumi, lūdzu, sazinieties ar mums:' : 'If you have any questions, please contact us:';
  const regardsText = isLV ? 'Ar cieņu,' : 'Best regards,';

  return `
<div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; padding: 0; border-radius: 8px; overflow: hidden;">
  <div style="background-color: #000; padding: 20px; text-align: center;">
    <h1 style="color: #fff; margin: 0; font-size: 24px;">ROKOF.LV</h1>
  </div>
  <div style="padding: 30px;">
    <h2 style="color: #000; margin-top: 0;">${title}</h2>
    <p>Labdien, <strong>${recipientName}</strong>!</p>
    <p>${content}</p>
    ${orderSummary || ''}
    <div style="background-color: #f4f4f4; padding: 20px; border-radius: 8px; margin: 30px 0; text-align: center;">
      <p style="margin-top: 0;"><strong>Jūsu konts:</strong> ${email}</p>
      <a href="${loginUrl}" style="display: inline-block; background-color: #000; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px;">${loginText}</a>
    </div>
    <p style="font-size: 0.85em; color: #666; border-top: 1px solid #eee; padding-top: 20px;">
      ${contactText} <a href="mailto:${ADMIN_EMAIL}" style="color: #000; font-weight: bold;">${ADMIN_EMAIL}</a>.<br>
      <a href="https://rokof.lv/privacy-policy" style="color: #666; text-decoration: underline;">${privacyText}</a>.
    </p>
    <p style="margin-top: 30px;">${regardsText}<br><strong>ROKOF.LV komanda</strong></p>
  </div>
</div>`;
}

function generateOrderEmailText(order: any) {
  const customerName = order.user?.firstName || order.user?.name || "Klients";
  const orderNumber = order.invoiceNumber || order.id;
  const totalAmount = Number(order.totalAmount || 0).toFixed(2);
  
  const productList = order.items.map((item: any) => 
    `- ${item.title} (${item.sku}): ${item.quantity} x €${Number(item.priceAtPurchase || item.price || 0).toFixed(2)} = €${Number(item.total || 0).toFixed(2)}`
  ).join('\n');

  return `Labdien / Здравствуйте, ${customerName}!

(LV): Paldies par Jūsu pasūtījumu ${orderNumber} vietnē ROKOF.LV.
Jūsu pasūtījuma dokumenti ir sagatavoti un pievienoti šim e-pastam (PDF).

(RU): Спасибо за Ваш заказ ${orderNumber} на сайте ROKOF.LV.
Документы по Вашему заказу подготовлены и прикреплены к этому письму (PDF).

Pasūtījuma detaļas / Детали заказа:
${productList}

Kopā apmaksai / Итого к оплате: €${totalAmount}

(LV): Ja Jums ir jautājumi, lūdzu, sazinieties ar mums, atbildot uz šo e-pastu.
(RU): Если у Вас есть вопросы, пожалуйста, ответьте на это письмо.

Ar cieņu / С уважением,
ROKOF.LV`;
}

// Basic Admin Middleware
const requireAdmin = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const logFile = 'admin_debug.log';
  const log = (msg: string) => fs.appendFileSync(logFile, `${new Date().toISOString()} - ${msg}\n`);

  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token || token === "null" || token === "undefined") {
    res.status(403).json({ error: "Forbidden: No valid token provided" });
    return;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as { role: string, userId: string, email?: string };
    
    // Query database for the most up-to-date role
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    
    log(`[requireAdmin] User: ${user?.email}, DB Role: ${user?.role}, Token Role: ${decoded.role}`);

    const isAdmin = user?.role?.toUpperCase() === "ADMIN" || user?.email === "pavels@pzka.lv" || decoded.role?.toUpperCase() === "ADMIN";

    if (!isAdmin) {
      log(`[requireAdmin] Access Denied for ${user?.email || decoded.userId}`);
      res.status(403).json({ 
        error: `Forbidden: Admin access required.`,
        debug: {
          receivedRole: user?.role || decoded.role,
          userId: decoded.userId,
          email: user?.email || decoded.email
        }
      });
      return;
    }
    (req as any).user = { ...decoded, ...user };
    next();
  } catch (err: any) {
    log(`[requireAdmin] JWT Verification Error: ${err.message}`);
    res.status(403).json({ error: `Forbidden: Invalid token - ${err.message}` });
    return;
  }
};

const requireOwnerOrAdmin = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers["authorization"];
  let token = authHeader && authHeader.split(" ")[1];

  if (!token || token === "null" || token === "undefined") {
    console.log("requireOwnerOrAdmin: No valid token provided", { token });
    res.status(403).json({ error: "Forbidden: No valid token provided" });
    return;
  }

  // Strip potential quotes
  if (token.startsWith('"') && token.endsWith('"')) {
    token = token.slice(1, -1);
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as { userId: string, role: string, email?: string };
    const userIdFromParams = req.params.userId;
    
    console.log("requireOwnerOrAdmin: Checking access", { decodedUserId: decoded.userId, userIdFromParams });

    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) {
      console.log("requireOwnerOrAdmin: User not found", { decodedUserId: decoded.userId });
      res.status(403).json({ error: "Forbidden: User not found" });
      return;
    }
    const isAdmin = user.role?.toUpperCase() === "ADMIN" || user.email === "pavels@pzka.lv" || decoded.role?.toUpperCase() === "ADMIN";

    if (isAdmin || decoded.userId === userIdFromParams) {
      next();
    } else {
      console.log("requireOwnerOrAdmin: Access denied", { isAdmin, decodedUserId: decoded.userId, userIdFromParams });
      res.status(403).json({ 
        error: "Forbidden: Access denied",
        debug: {
          receivedRole: user?.role || decoded.role,
          userId: decoded.userId,
          email: user?.email || decoded.email,
          userIdFromParams
        }
      });
    }
  } catch (err) {
    console.log("requireOwnerOrAdmin: Token verification failed", err);
    res.status(403).json({ error: "Forbidden: Invalid token" });
  }
};

const requireAuth = (req: any, res: any, next: any) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as { userId: string, role: string };
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
};

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per `window` (here, per 15 minutes)
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

let robotoFontBuffer: Buffer | null = null;

const numberToWordsLV = (amount: number): string => {
  const units = ["", "viens", "divi", "trīs", "četri", "pieci", "seši", "septiņi", "astoņi", "deviņi"];
  const teens = ["desmit", "vienpadsmit", "divpadsmit", "trīspadsmit", "četrpadsmit", "piecpadsmit", "sešpadsmit", "septiņpadsmit", "astoņpadsmit", "deviņpadsmit"];
  const tens = ["", "desmit", "divdesmit", "trīsdesmit", "četrdesmit", "piecdesmit", "sešdesmit", "septiņdesmit", "astoņdesmit", "deviņdesmit"];
  const hundreds = ["", "simts", "divi simti", "trīs simti", "četri simti", "pieci simti", "seši simti", "septiņi simti", "astoņi simti", "deviņi simti"];

  const integerPart = Math.floor(amount);
  const decimalPart = Math.round((amount - integerPart) * 100);

  const convertThreeDigits = (n: number): string => {
    let res = "";
    const h = Math.floor(n / 100);
    const t = Math.floor((n % 100) / 10);
    const u = n % 10;

    if (h > 0) res += hundreds[h] + " ";
    if (t === 1) {
      res += teens[u] + " ";
    } else {
      if (t > 1) res += tens[t] + " ";
      if (u > 0) res += units[u] + " ";
    }
    return res.trim();
  };

  let result = "";
  if (integerPart === 0) {
    result = "nulle";
  } else {
    const millions = Math.floor(integerPart / 1000000);
    const thousands = Math.floor((integerPart % 1000000) / 1000);
    const remainder = integerPart % 1000;

    if (millions > 0) {
      if (millions === 1) result += "viens miljons ";
      else result += convertThreeDigits(millions) + " miljoni ";
    }
    if (thousands > 0) {
      if (thousands === 1) result += "viens tūkstotis ";
      else result += convertThreeDigits(thousands) + " tūkstoši ";
    }
    result += convertThreeDigits(remainder);
  }

  const eiroStr = "eiro";
  const centiStr = (decimalPart % 10 === 1 && decimalPart % 100 !== 11) ? "cents" : "centi";

  return `${result.trim()} ${eiroStr}, ${decimalPart} ${centiStr}`;
};

async function getRobotoFont() {
  if (!robotoFontBuffer) {
    const fontPath = path.join(process.cwd(), 'assets', 'fonts', 'Roboto-Regular.ttf');
    robotoFontBuffer = fs.readFileSync(fontPath);
  }
  return robotoFontBuffer;
}

const getVatRate = (countryCode?: string): number => {
  if (!countryCode) return 0.21;
  const code = countryCode.toUpperCase();
  const rates: Record<string, number> = {
    'LV': 0.21,
    'LT': 0.21,
    'EE': 0.22,
    'DE': 0.19,
    'PL': 0.23,
    'FI': 0.24,
    'SE': 0.25,
    'DK': 0.25,
    'FR': 0.20,
    'IT': 0.22,
    'ES': 0.21,
    'AT': 0.20,
    'BE': 0.21,
    'NL': 0.21,
  };
  return rates[code] || 0.21;
};

async function getNextSequence(name: string, tx: any): Promise<number> {
  const seq = await tx.sequence.upsert({
    where: { name },
    update: { value: { increment: 1 } },
    create: { name, value: 1 }
  });
  return seq.value;
}

export const app = express();

export async function startServer() {
  const PORT = 3000;

  app.set('trust proxy', 1);

  // Ensure uploads directory exists
  const uploadDir = path.join(process.cwd(), 'public', 'uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  // Configure multer for documents
  const documentStorage = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, uploadDir)
    },
    filename: function (req, file, cb) {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
      cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname))
    }
  })
  const documentUpload = multer({ storage: documentStorage });

  // Serve uploads
  app.use('/uploads', express.static(uploadDir));

  async function handleOrderDocumentUpload(
    req: any,
    res: any,
    updateOrderFn: (id: string, fileUrl: string, file: any) => Promise<any>,
    shouldSendEmailFn: (order: any) => boolean,
    emailSubjectFn: (orderNumber: string) => string,
    attachmentFilenameFn: (orderNumber: string) => string
  ) {
    try {
      const id = req.params.id as string;
      const file = req.file;
      
      if (!file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }
      
      const existingOrder = await prisma.order.findUnique({ where: { id }, include: { user: true } });
      if (!existingOrder) {
        res.status(404).json({ error: "Order not found" });
        return;
      }
      
      const fileUrl = `/uploads/${file.filename}`;
      
      const updatedOrder = await updateOrderFn(id, fileUrl, file);
      
      if (updatedOrder.user && updatedOrder.user.email && shouldSendEmailFn(updatedOrder)) {
        try {
          const orderNumber = updatedOrder.pavadzimeNumber || updatedOrder.rkfInvoiceNumber || updatedOrder.invoiceNumber || updatedOrder.id;
          await transporter.sendMail({
            from: `"ROKOF" <${ADMIN_EMAIL}>`,
            to: updatedOrder.user.email,
            subject: emailSubjectFn(orderNumber),
            text: generateOrderEmailText(updatedOrder),
            attachments: [
              {
                filename: attachmentFilenameFn(orderNumber),
                path: path.join(process.cwd(), 'public', fileUrl)
              }
            ]
          });
        } catch (emailError) {
          console.error("Failed to send email:", emailError);
        }
      }
      
      res.json(updatedOrder);
    } catch (error) {
      console.error("Failed to process document upload:", error);
      res.status(500).json({ error: "Failed to process document upload" });
    }
  }

  // DOCUMENT UPLOADS
  app.post("/api/orders/:id/delivery-document", requireAdmin, documentUpload.single("file"), async (req, res) => {
    await handleOrderDocumentUpload(
      req,
      res,
      async (id, fileUrl) => {
        return prisma.order.update({
          where: { id },
          data: { 
            deliveryDocumentUrl: fileUrl,
            status: 'SHIPPED' // Set to SHIPPED as per user requirement for delivery document
          },
          include: { user: true, items: true }
        });
      },
      () => true,
      (orderNumber) => `Pasūtījums ${orderNumber} ir izsūtīts!`,
      (orderNumber) => `Piegades_dokuments_${orderNumber}.pdf`
    );
  });

  app.post("/api/orders/:id/invoice", requireAdmin, documentUpload.single("file"), async (req, res) => {
    await handleOrderDocumentUpload(
      req,
      res,
      async (id, fileUrl, file) => {
        // Extract pavadzime number from filename
        // Example: "Rēķins RKF-000159 TEZLi SIA.pdf" -> "RKF-000159"
        let pavadzimeNumber = null;
        const match = file.originalname.match(/(RKF-\d+)/);
        if (match) {
          pavadzimeNumber = match[1];
        } else {
          // Fallback: try to find any pattern like XXX-XXXXX
          const genericMatch = file.originalname.match(/([A-Z]+-\d+)/);
          if (genericMatch) {
            pavadzimeNumber = genericMatch[1];
          }
        }
        
        const updatedOrder = await prisma.order.update({
          where: { id },
          data: { 
            invoiceUrl: fileUrl,
            pavadzimeNumber: pavadzimeNumber || undefined
          },
          include: { user: true, items: true }
        });

        // Calculate warranty for items if not already set
        for (const item of updatedOrder.items) {
          if (!item.warrantyUntil) {
            const product = await prisma.product.findUnique({ where: { id: item.productId } });
            if (product) {
              const warrantyMonths = product.warrantyMonths || 36;
              const warrantyUntil = new Date();
              warrantyUntil.setMonth(warrantyUntil.getMonth() + warrantyMonths);
              await prisma.orderItem.update({
                where: { id: item.id },
                data: { warrantyUntil }
              });
            }
          }
        }
        return updatedOrder;
      },
      (order) => order.status === 'COMPLETED',
      (orderNumber) => `Pavadzīme ${orderNumber}`,
      (orderNumber) => `Pavadzime_${orderNumber}.pdf`
    );
  });

  app.post("/api/orders/:id/prepayment-invoice", requireAdmin, documentUpload.single("file"), async (req, res) => {
    await handleOrderDocumentUpload(
      req,
      res,
      async (id, fileUrl) => {
        return prisma.order.update({
          where: { id },
          data: { prepaymentInvoiceUrl: fileUrl },
          include: { user: true, items: true }
        });
      },
      () => true,
      (orderNumber) => `Priekšapmaksas rēķins ${orderNumber}`,
      (orderNumber) => `Rekins_${orderNumber}.pdf`
    );
  });

  // --- STRIPE WEBHOOK ---
  app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      if (process.env.NODE_ENV === 'test') {
        event = JSON.parse(req.body.toString());
      } else {
        event = stripe.webhooks.constructEvent(req.body, sig as string, process.env.STRIPE_WEBHOOK_SECRET!);
      }
    } catch (err: any) {
      console.error(`Webhook Error: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      // Idempotency check
      try {
        await prisma.processedWebhook.create({
          data: { eventId: event.id }
        });
      } catch (err: any) {
        if (err.code === 'P2002') {
          console.log(`Webhook ${event.id} already processed. Skipping.`);
          return res.json({ received: true });
        }
        throw err;
      }

      if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const orderId = paymentIntent.metadata.orderId;
        
        if (!orderId) {
          return res.json({ received: true });
        }

        const order = await prisma.order.findUnique({ where: { id: orderId } });
        if (!order) {
          console.error(`Webhook Error: Order ${orderId} not found`);
          return res.json({ received: true });
        }

        // Validate amount to prevent price tampering
        if (paymentIntent.amount !== Math.round(order.totalAmount * 100)) {
          console.error(`Webhook Error: Amount mismatch for order ${orderId}`);
          return res.json({ received: true });
        }

        // Idempotent update
        await prisma.order.updateMany({
          where: { id: orderId, status: 'NEW' },
          data: { status: 'PAID' }
        });
        
        console.log(`Order ${orderId} marked as PAID`);
        
      } else if (event.type === 'payment_intent.payment_failed' || event.type === 'payment_intent.canceled') {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const orderId = paymentIntent.metadata.orderId;
        
        if (!orderId) {
          return res.json({ received: true });
        }

        // Inventory Leak Fix: Return stock if payment fails/cancels
        // Use atomic updateMany to prevent Inventory Inflation (Race Condition)
        const updated = await prisma.order.updateMany({
          where: { id: orderId, status: 'NEW' },
          data: { status: 'CANCELLED' }
        });

        if (updated.count > 0) {
          const order = await prisma.order.findUnique({ 
            where: { id: orderId }, include: { items: true } 
          });
          
          if (order) {
            await prisma.$transaction(async (tx) => {
              for (const item of order.items) {
                await tx.product.update({
                  where: { id: item.productId },
                  data: { stockQuantity: { increment: item.quantity } }
                });
              }
            });
            console.log(`Order ${orderId} cancelled, inventory restored.`);
          }
        }
      }
      res.json({ received: true });
    } catch (error) {
      console.error("Webhook handler failed:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // --- INVOICE API ---
  app.use("/api/invoices", requireAdmin, invoiceRouter);

  // --- AUTH API ---
  app.post("/api/register", authLimiter, async (req, res) => {
    try {
      const { 
        email: rawEmail, 
        password, 
        role, 
        type, 
        firstName, 
        lastName, 
        phone, 
        companyName, 
        regNo, 
        vatNo, 
        legalAddress, 
        language,
        marketingConsent 
      } = req.body;

      const email = rawEmail.toLowerCase();

      if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
      }

      const userLanguage = language || 'lv';

      // Check if user exists
      let newUser;
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
        if (existingUser.type === 'UNREGISTERED') {
          // Allow unregistered users to convert to registered
          const salt = await bcrypt.genSalt(10);
          const passwordHash = await bcrypt.hash(password, salt);
          
          newUser = await prisma.user.update({
            where: { email },
            data: {
              passwordHash,
              type: type || "INDIVIDUAL",
              firstName: firstName || existingUser.firstName,
              lastName: lastName || existingUser.lastName,
              phone: phone || existingUser.phone,
              companyName: companyName || existingUser.companyName,
              regNo: regNo || existingUser.regNo,
              vatNo: vatNo || existingUser.vatNo,
              legalAddress: legalAddress || existingUser.legalAddress,
              language: userLanguage,
              discountLevel: type === 'BUSINESS' ? 20 : 0,
              tier: "BRONZE",
              marketingConsent: !!marketingConsent,
              consentTimestamp: new Date()
            }
          });
        } else {
          return res.status(400).json({ 
            error: "Lietotājs ar šādu e-pastu jau eksistē. Lūdzu, ienāciet sistēmā vai atjaunojiet paroli.",
            code: "USER_ALREADY_EXISTS"
          });
        }
      } else {
        // Check if this is the first user
        const userCount = await prisma.user.count();
        const isFirstUser = userCount === 0;
        const finalRole = isFirstUser ? "ADMIN" : (role || "CUSTOMER");

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        newUser = await prisma.user.create({
          data: {
            email,
            passwordHash,
            role: finalRole,
            type: type || "INDIVIDUAL",
            firstName: firstName || "",
            lastName: lastName || "",
            phone: phone || "",
            companyName: companyName || "",
            regNo: regNo || "",
            vatNo: vatNo || "",
            legalAddress: legalAddress || "",
            language: userLanguage,
            discountLevel: type === 'BUSINESS' ? 20 : 0,
            tier: "BRONZE",
            marketingConsent: !!marketingConsent,
            consentTimestamp: new Date()
          }
        });
      }

      // Return user without password hash
      const { passwordHash: _, ...userWithoutPassword } = newUser;

      // Send Welcome Email
      try {
        const recipientName = type === 'BUSINESS' && companyName ? companyName : `${firstName || ''} ${lastName || ''}`.trim();
        await sendWelcomeEmail(email, recipientName, userLanguage);
      } catch (emailError) {
        console.error("Failed to send welcome email:", emailError);
      }

      const token = jwt.sign(
        { userId: newUser.id, role: newUser.role },
        process.env.JWT_SECRET as string,
        { expiresIn: '24h' }
      );

      res.json({ ...userWithoutPassword, token });
    } catch (error) {
      console.error("Full Registration Error:", JSON.stringify(error, null, 2));
      
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        console.error("Prisma Error Code:", error.code);
        console.error("Prisma Error Meta:", error.meta);
        if (error.code === 'P2002') {
          return res.status(400).json({ 
            error: "Lietotājs ar šādu e-pastu jau eksistē. Lūdzu, ienāciet sistēmā vai atjaunojiet paroli.",
            code: "USER_ALREADY_EXISTS"
          });
        }
      }
      
      res.status(500).json({ 
        error: "Reģistrācija neizdevās", 
        details: error instanceof Error ? error.message : "Unknown error" 
      });
    }
  });

  app.post("/api/login", authLimiter, async (req, res) => {
    try {
      const { email: rawEmail, password } = req.body;
      const email = rawEmail.toLowerCase();
      
      if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !user.passwordHash) {
        console.log(`Login failed: User not found or no password hash for ${email}`);
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const isMatch = await bcrypt.compare(password, user.passwordHash);
      if (!isMatch) {
        console.log(`Login failed: Password mismatch for ${email}`);
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const { passwordHash: _, ...userWithoutPassword } = user;

      console.log(`User ${user.email} (ID: ${user.id}) logged in with role: ${user.role}`);
      const token = jwt.sign(
        { userId: user.id, role: user.role, email: user.email },
        process.env.JWT_SECRET as string,
        { expiresIn: '24h' }
      );

      res.json({ ...userWithoutPassword, token });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  app.post("/api/auth/forgot-password", authLimiter, async (req, res) => {
    try {
      const { email: rawEmail } = req.body;
      const email = rawEmail.toLowerCase();
      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        // Return success even if user not found to prevent email enumeration
        return res.json({ success: true });
      }

      // Generate token
      const resetToken = crypto.randomBytes(32).toString("hex");
      const resetTokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
      
      // Token valid for 1 hour
      const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          resetToken: resetTokenHash,
          resetTokenExpiry,
        }
      });

      const appUrl = process.env.APP_URL || 'https://rokof.lv';
      const resetLink = `${appUrl}/reset-password?token=${resetToken}&email=${encodeURIComponent(email)}`;

      const lang = user.language || 'lv';
      let subject = "Paroles atjaunošana";
      let text = `Paroles atjaunošana. Spiediet šeit, lai nomainītu paroli (saite ir aktīva 1 stundu):\n\n${resetLink}`;

      if (lang === 'ru') {
        subject = "Восстановление пароля";
        text = `Восстановление пароля. Нажмите здесь, чтобы изменить пароль (ссылка активна 1 час):\n\n${resetLink}`;
      } else if (lang === 'en') {
        subject = "Password Reset";
        text = `Password reset. Click here to change your password (link is active for 1 hour):\n\n${resetLink}`;
      }

      await transporter.sendMail({
        from: `"ROKOF" <${ADMIN_EMAIL}>`,
        to: email,
        subject: subject,
        text: text
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Forgot password error:", error);
      res.status(500).json({ error: "Failed to process request" });
    }
  });

  app.post("/api/auth/reset-password", async (req, res) => {
    try {
      const { email, token, newPassword } = req.body;
      if (!email || !token || !newPassword) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !user.resetToken || !user.resetTokenExpiry) {
        return res.status(400).json({ error: "Invalid or expired token" });
      }

      if (user.resetTokenExpiry < new Date()) {
        return res.status(400).json({ error: "Token has expired" });
      }

      const providedTokenHash = crypto.createHash("sha256").update(token).digest("hex");
      if (user.resetToken !== providedTokenHash) {
        return res.status(400).json({ error: "Invalid token" });
      }

      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(newPassword, salt);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          resetToken: null,
          resetTokenExpiry: null,
        }
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Reset password error:", error);
      res.status(500).json({ error: "Failed to reset password" });
    }
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/debug/me", (req, res) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (!token) return res.json({ error: "No token" });
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET as string);
      res.json({ decoded, secret_length: (process.env.JWT_SECRET || "").length });
    } catch (err: any) {
      res.json({ error: err.message });
    }
  });

  // --- ANALYTICS API ---
  app.get("/api/analytics", requireAdmin, async (req, res) => {
    try {
      const [totalUsers, orderStats] = await Promise.all([
        prisma.user.count(),
        prisma.order.aggregate({
          _sum: { totalAmount: true },
          _count: { id: true }
        })
      ]);

      res.json({
        totalUsers,
        orderCount: orderStats._count.id,
        totalSales: orderStats._sum.totalAmount || 0
      });
    } catch (error) {
      console.error("Failed to fetch analytics:", error);
      res.status(500).json({ error: "Failed to fetch analytics" });
    }
  });

  app.get("/api/analytics/detailed", requireAdmin, async (req, res) => {
    try {
      const now = new Date();
      const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

      // 1. Monthly Stats using Aggregations
      const [currentMonthAgg, prevMonthAgg] = await Promise.all([
        prisma.order.aggregate({
          where: { 
            status: 'COMPLETED',
            createdAt: { gte: currentMonthStart }
          },
          _sum: { totalAmount: true },
          _count: { id: true }
        }),
        prisma.order.aggregate({
          where: { 
            status: 'COMPLETED',
            createdAt: { gte: prevMonthStart, lte: prevMonthEnd }
          },
          _sum: { totalAmount: true },
          _count: { id: true }
        })
      ]);

      // 2. SKU Performance using GroupBy
      // We fetch all product-level stats to calculate both Top SKUs and Brand Performance
      const itemStats = await prisma.orderItem.groupBy({
        by: ['productId'],
        where: {
          order: {
            status: 'COMPLETED'
          }
        },
        _sum: {
          quantity: true,
          total: true
        },
      });

      // Fetch product details for the items found
      const productIds = itemStats.map(stat => stat.productId);
      const products = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, sku: true, titleLV: true, titleEN: true, titleRU: true, brand: true }
      });
      
      const productMap = new Map(products.map(p => [p.id, p]));

      // Process SKU and Brand stats
      const skuStats = [];
      const brandStatsMap: Record<string, number> = {};

      for (const stat of itemStats) {
        const product = productMap.get(stat.productId);
        const revenue = stat._sum.total || 0;
        const quantity = stat._sum.quantity || 0;
        const brand = product?.brand || 'ROKOF';
        
        // SKU Stats
        skuStats.push({
          sku: product?.sku || 'N/A',
          title: product?.titleLV || product?.titleEN || 'Unknown',
          quantity,
          revenue
        });

        // Brand Stats
        brandStatsMap[brand] = (brandStatsMap[brand] || 0) + revenue;
      }

      // Sort and slice for Top 10 SKUs
      const topSKUs = skuStats.sort((a, b) => b.revenue - a.revenue).slice(0, 10);
      
      // Process Brand Performance
      const brandPerformance = Object.entries(brandStatsMap)
        .map(([brand, revenue]) => ({ brand, revenue }))
        .sort((a, b) => b.revenue - a.revenue);

      res.json({
        summary: {
          currentMonth: { 
            revenue: currentMonthAgg._sum.totalAmount || 0, 
            orders: currentMonthAgg._count.id 
          },
          prevMonth: { 
            revenue: prevMonthAgg._sum.totalAmount || 0, 
            orders: prevMonthAgg._count.id 
          }
        },
        topSKUs,
        brandPerformance
      });

    } catch (error) {
      console.error("Failed to fetch detailed analytics:", error);
      res.status(500).json({ error: "Failed to fetch detailed analytics" });
    }
  });

  // --- CUSTOMERS API ---
  app.get("/api/users", requireAdmin, async (req, res) => {
    try {
      const users = await prisma.user.findMany({
        orderBy: { createdAt: 'desc' }
      });
      res.json(users);
    } catch (error) {
      console.error("Failed to fetch users:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  app.get("/api/users/:id", requireAdmin, async (req, res) => {
    try {
      const id = req.params.id as string;
      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      const { passwordHash: _, ...userWithoutPassword } = user;
      res.json(userWithoutPassword);
    } catch (error) {
      console.error("Failed to fetch user:", error);
      res.status(500).json({ error: "Failed to fetch user" });
    }
  });

  app.patch("/api/users/:id", requireAdmin, async (req, res) => {
    try {
      const id = req.params.id as string;
      const { tier, discountLevel } = req.body;
      
      const updateData: any = {};
      if (tier !== undefined) updateData.tier = tier;
      if (discountLevel !== undefined) updateData.discountLevel = discountLevel;

      const user = await prisma.user.update({
        where: { id },
        data: updateData
      });
      res.json(user);
    } catch (error) {
      console.error("Failed to update user:", error);
      res.status(500).json({ error: "Failed to update user" });
    }
  });

  app.put("/api/users/:id/tier", requireAdmin, async (req, res) => {
    try {
      const id = req.params.id as string;
      const { tier } = req.body; // BRONZE, SILVER, GOLD
      const user = await prisma.user.update({
        where: { id },
        data: { tier }
      });
      res.json(user);
    } catch (error) {
      console.error("Failed to update user tier:", error);
      res.status(500).json({ error: "Failed to update user tier" });
    }
  });

  // --- CATEGORIES API ---
  app.get("/api/categories/tree", async (req, res) => {
    try {
      const categories = await prisma.category.findMany();
      
      const buildTree = (parentId: string | null = null): any[] => {
        return categories
          .filter(c => c.parentId === parentId)
          .map(c => ({
            ...c,
            children: buildTree(c.id)
          }));
      };

      const tree = buildTree(null);
      res.json(tree);
    } catch (error) {
      console.error("Failed to fetch category tree:", error);
      res.status(500).json({ error: "Failed to fetch category tree" });
    }
  });

  app.post("/api/categories", requireAdmin, async (req, res) => {
    try {
      const { nameLV, nameRU, nameEN, slug, parentId } = req.body;
      const category = await prisma.category.create({
        data: { nameLV, nameRU, nameEN, slug, parentId }
      });
      res.json(category);
    } catch (error) {
      console.error("Failed to create category:", error);
      res.status(500).json({ error: "Failed to create category" });
    }
  });

  // --- PRODUCTS API ---
  // --- PROMOTIONS ---
  app.get("/api/promotions", requireAdmin, async (req, res) => {
    try {
      const promotions = await prisma.promotion.findMany();
      res.json(promotions);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch promotions" });
    }
  });

  app.post("/api/promotions", requireAdmin, async (req, res) => {
    try {
      const { name, discountType, value, startDate, endDate, targetType, targetId } = req.body;
      const promotion = await prisma.promotion.create({
        data: {
          name,
          discountType,
          value,
          startDate: new Date(startDate),
          endDate: new Date(endDate),
          targetType,
          targetId
        }
      });
      res.json(promotion);
    } catch (error) {
      res.status(500).json({ error: "Failed to create promotion" });
    }
  });

  app.delete("/api/promotions/:id", requireAdmin, async (req, res) => {
    try {
      const id = req.params.id as string;
      await prisma.promotion.delete({ where: { id } });
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete promotion" });
    }
  });

  // --- HELPERS FOR PRICING ---
  async function getLowestPriceInLast30Days(productId: string, currentPrice: number) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentHistory = await prisma.priceHistory.findMany({
      where: {
        productId,
        changedAt: { gte: thirtyDaysAgo }
      }
    });

    const olderHistory = await prisma.priceHistory.findFirst({
      where: {
        productId,
        changedAt: { lt: thirtyDaysAgo }
      },
      orderBy: { changedAt: 'desc' }
    });

    const prices = recentHistory.map(h => h.price);
    if (olderHistory) prices.push(olderHistory.price);
    prices.push(currentPrice);

    return Math.min(...prices);
  }

  async function getActivePromotions() {
    const now = new Date();
    return await prisma.promotion.findMany({
      where: {
        startDate: { lte: now },
        endDate: { gte: now }
      }
    });
  }

  function calculateDiscountedPrice(product: any, promotions: any[]) {
    let bestPrice = product.price;
    let onSale = false;

    for (const promo of promotions) {
      let applies = false;
      if (promo.targetType === 'PRODUCT' && promo.targetId === product.id) {
        applies = true;
      } else if (promo.targetType === 'CATEGORY' && promo.targetId === product.category) {
        applies = true;
      }

      if (applies) {
        let discountedPrice = product.price;
        if (promo.discountType === 'PERCENTAGE') {
          discountedPrice = product.price * (1 - promo.value / 100);
        } else if (promo.discountType === 'FIXED') {
          discountedPrice = Math.max(0, product.price - promo.value);
        }

        if (discountedPrice < bestPrice) {
          bestPrice = discountedPrice;
          onSale = true;
        }
      }
    }

    return { bestPrice, onSale };
  }

  app.get("/api/products", async (req, res) => {
    try {
      const { category, minPrice, maxPrice, q, includeFacets, ...specs } = req.query;

      const where: any = {};
      if (category) where.category = category as string;
      
      // Basic search query
      if (q) {
        const searchStr = String(q).toLowerCase();
        where.OR = [
          { titleLV: { contains: searchStr } },
          { titleRU: { contains: searchStr } },
          { titleEN: { contains: searchStr } },
          { sku: { contains: searchStr } },
          { descriptionLV: { contains: searchStr } },
          { descriptionRU: { contains: searchStr } },
          { descriptionEN: { contains: searchStr } }
        ];
      }

      const products = await prisma.product.findMany({
        where,
        orderBy: { createdAt: 'desc' }
      });
      
      const activePromotions = await getActivePromotions();

      // Parse JSON strings and apply faceted filtering
      let parsedProducts = await Promise.all(products.map(async p => {
        const { bestPrice, onSale } = calculateDiscountedPrice(p, activePromotions);
        let lowestPrice30d = p.price;
        if (onSale) {
          lowestPrice30d = await getLowestPriceInLast30Days(p.id, p.price);
        }

        return {
          ...p,
          originalPrice: p.price,
          price: bestPrice,
          onSale,
          lowestPrice30d,
          images: JSON.parse(p.images || '[]'),
          specifications: JSON.parse(p.specifications || '{}'),
          euResponsiblePerson: p.euResponsiblePerson ? JSON.parse(p.euResponsiblePerson) : null,
          title: {
            LV: p.titleLV,
            RU: p.titleRU,
            EN: p.titleEN
          },
          description: {
            LV: p.descriptionLV || '',
            RU: p.descriptionRU || '',
            EN: p.descriptionEN || ''
          }
        };
      }));

      // Apply price filters after promotion calculation
      if (minPrice) {
        parsedProducts = parsedProducts.filter(p => p.price >= parseFloat(minPrice as string));
      }
      if (maxPrice) {
        parsedProducts = parsedProducts.filter(p => p.price <= parseFloat(maxPrice as string));
      }

      // Apply dynamic specification filters
      const activeFilters = Object.entries(specs).filter(([key, value]) => 
        value !== undefined && !['category', 'minPrice', 'maxPrice', 'includeFacets', 'q'].includes(key)
      );

      if (activeFilters.length > 0) {
        parsedProducts = parsedProducts.filter(p => {
          return activeFilters.every(([key, value]) => {
            const productSpecValue = p.specifications[key];
            if (!productSpecValue) return false;
            
            const values = Array.isArray(value) ? value : [value];
            return values.some(v => {
              const normalizedV = (key === 'powerPerMeter' || key === 'length') ? String(v).replace(/[Wm]/g, '') : v;
              return String(productSpecValue) === String(normalizedV);
            });
          });
        });
      }

      // Calculate facets for the UI
      const facets: any = {
        categories: {},
        specifications: {}
      };

      // Calculate facets based on products matching the basic filters (category + search)
      products.forEach(p => {
        const pSpecs = JSON.parse(p.specifications || '{}');
        Object.entries(pSpecs).forEach(([key, value]) => {
          if (!facets.specifications[key]) facets.specifications[key] = {};
          const valStr = String(value);
          facets.specifications[key][valStr] = (facets.specifications[key][valStr] || 0) + 1;
        });
        facets.categories[p.category] = (facets.categories[p.category] || 0) + 1;
      });
      
      // If query has 'includeFacets', return object, otherwise return array for backward compatibility
      if (includeFacets === 'true') {
        res.json({
          products: parsedProducts,
          facets
        });
      } else {
        res.json(parsedProducts);
      }
    } catch (error) {
      console.error("Failed to fetch products. Error details:", {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        query: req.query
      });
      res.status(500).json({ 
        error: "Failed to fetch products",
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/api/products/:id", async (req, res) => {
    try {
      const id = req.params.id as string;
      const product = await prisma.product.findUnique({ where: { id } });
      if (!product) return res.status(404).json({ error: "Product not found" });
      
      const activePromotions = await getActivePromotions();
      const { bestPrice, onSale } = calculateDiscountedPrice(product, activePromotions);
      let lowestPrice30d = product.price;
      if (onSale) {
        lowestPrice30d = await getLowestPriceInLast30Days(product.id, product.price);
      }

      const parsedProduct = {
        ...product,
        originalPrice: product.price,
        price: bestPrice,
        onSale,
        lowestPrice30d,
        category: product.category as any,
        images: JSON.parse(product.images || '[]'),
        specifications: JSON.parse(product.specifications || '{}'),
        euResponsiblePerson: product.euResponsiblePerson ? JSON.parse(product.euResponsiblePerson) : null,
        title: {
          LV: product.titleLV,
          RU: product.titleRU,
          EN: product.titleEN
        },
        description: {
          LV: product.descriptionLV || '',
          RU: product.descriptionRU || '',
          EN: product.descriptionEN || ''
        }
      };
      
      res.json(parsedProduct);
    } catch (error) {
      console.error("Failed to fetch product:", error);
      res.status(500).json({ error: "Failed to fetch product" });
    }
  });

  app.post("/api/products", requireAdmin, async (req, res) => {
    try {
      const {
        sku,
        title,
        description,
        category,
        price,
        b2bPrice,
        unit,
        stockQuantity,
        warrantyMonths,
        brand,
        images,
        specifications,
        energyClass,
        technicalDocumentationUrl,
        euResponsiblePerson
      } = req.body;

      const product = await prisma.product.create({
        data: {
          sku,
          brand: brand || "ROKOF",
          titleLV: title.LV,
          titleRU: title.RU,
          titleEN: title.EN,
          descriptionLV: description.LV,
          descriptionRU: description.RU,
          descriptionEN: description.EN,
          category,
          price,
          b2bPrice,
          unit,
          stockQuantity,
          warrantyMonths: warrantyMonths || 36,
          images: JSON.stringify(images),
          specifications: JSON.stringify(specifications),
          energyClass,
          technicalDocumentationUrl,
          euResponsiblePerson: euResponsiblePerson ? JSON.stringify(euResponsiblePerson) : null
        }
      });

      // Log initial price
      await prisma.priceHistory.create({
        data: {
          productId: product.id,
          price: product.price
        }
      });

      res.json(product);
    } catch (error) {
      console.error("Failed to create product:", error);
      res.status(500).json({ error: "Failed to create product" });
    }
  });

  app.put("/api/products/:id", requireAdmin, async (req, res) => {
    try {
      const id = req.params.id as string;
      const {
        sku,
        title,
        description,
        category,
        price,
        b2bPrice,
        unit,
        stockQuantity,
        warrantyMonths,
        brand,
        images,
        specifications,
        energyClass,
        technicalDocumentationUrl,
        euResponsiblePerson
      } = req.body;

      const oldProduct = await prisma.product.findUnique({ where: { id } });
      
      const product = await prisma.product.update({
        where: { id },
        data: {
          sku,
          brand: brand || "ROKOF",
          titleLV: title.LV,
          titleRU: title.RU,
          titleEN: title.EN,
          descriptionLV: description.LV,
          descriptionRU: description.RU,
          descriptionEN: description.EN,
          category,
          price,
          b2bPrice,
          unit,
          stockQuantity,
          warrantyMonths: warrantyMonths || 36,
          images: JSON.stringify(images),
          specifications: JSON.stringify(specifications),
          energyClass,
          technicalDocumentationUrl,
          euResponsiblePerson: euResponsiblePerson ? JSON.stringify(euResponsiblePerson) : null
        }
      });

      if (oldProduct && oldProduct.price !== price) {
        await prisma.priceHistory.create({
          data: {
            productId: id,
            price: price // Log the NEW price
          }
        });
      }

      res.json(product);
    } catch (error) {
      console.error("Failed to update product:", error);
      res.status(500).json({ error: "Failed to update product" });
    }
  });

  app.put("/api/orders/items/:itemId/warranty", requireAdmin, async (req, res) => {
    try {
      const itemId = req.params.itemId as string;
      const { warrantyUntil } = req.body; // ISO date string

      const updatedItem = await prisma.orderItem.update({
        where: { id: itemId },
        data: { warrantyUntil: new Date(warrantyUntil) }
      });

      res.json(updatedItem);
    } catch (error) {
      console.error("Failed to update warranty:", error);
      res.status(500).json({ error: "Failed to update warranty" });
    }
  });

  // --- USER ORDERS (PROTECTED) ---
  app.get("/api/users/:userId/orders", requireOwnerOrAdmin, async (req, res) => {
    try {
      const userId = req.params.userId as string;
      const orders = await prisma.order.findMany({
        where: { userId },
        include: { items: true },
        orderBy: { createdAt: 'desc' }
      });
      res.json(orders);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  });

  // --- CART (PROTECTED) ---
  app.get("/api/users/:userId/cart", requireOwnerOrAdmin, async (req, res) => {
    try {
      const userId = req.params.userId as string;
      const cart = await prisma.cartItem.findMany({
        where: { userId },
        include: { product: true }
      });
      res.json(cart);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch cart" });
    }
  });

  app.post("/api/cart/sync", async (req, res) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as { userId: string };
      const userId = decoded.userId;

      const { items } = req.body;
      if (!items || !Array.isArray(items)) {
        return res.status(400).json({ error: "Invalid items" });
      }

      await prisma.$transaction(async (tx) => {
        for (const item of items) {
          try {
            const prodId = String(item.productId);
            const qty = parseInt(item.quantity, 10);
            if (isNaN(qty) || qty <= 0) continue;

            const product = await tx.product.findUnique({ where: { id: prodId } });
            if (!product) continue;

            const existing = await tx.cartItem.findUnique({
              where: { userId_productId: { userId, productId: prodId } }
            });

            const currentQty = existing ? existing.quantity : 0;
            const targetQty = currentQty + qty;

            if (product.stockQuantity < targetQty) {
              const cappedQty = Math.max(0, product.stockQuantity);
              if (cappedQty > 0) {
                await tx.cartItem.upsert({
                  where: { userId_productId: { userId, productId: prodId } },
                  update: { quantity: cappedQty },
                  create: { userId, productId: prodId, quantity: cappedQty }
                });
                const reservationKey = `cart:reservation:${userId}:${prodId}`;
                await redis.setex(reservationKey, 3600, cappedQty.toString());
              }
              continue;
            }

            await tx.cartItem.upsert({
              where: { userId_productId: { userId, productId: prodId } },
              update: { quantity: targetQty },
              create: { userId, productId: prodId, quantity: targetQty }
            });

            const reservationKey = `cart:reservation:${userId}:${prodId}`;
            await redis.setex(reservationKey, 3600, targetQty.toString());
          } catch (e) {
            console.error(`Failed to sync cart item ${item.productId}:`, e);
          }
        }
      });
      
      const updatedCart = await prisma.cartItem.findMany({ where: { userId }, include: { product: true } });
      res.json(updatedCart);
    } catch (error: any) {
      if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
        res.status(401).json({ error: "Invalid token" });
      } else {
        console.error("Cart sync error:", error);
        res.status(500).json({ error: "Failed to sync cart" });
      }
    }
  });

  app.post("/api/users/:userId/cart", requireOwnerOrAdmin, async (req, res) => {
    try {
      const userId = req.params.userId as string;
      const { productId, quantity } = req.body;

      if (!productId) {
        return res.status(400).json({ error: "Product ID is required" });
      }

      const prodId = String(productId);
      
      // Ensure target user exists
      const targetUser = await prisma.user.findUnique({ where: { id: userId } });
      if (!targetUser) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Ensure quantity is a valid number
      const parsedQuantity = parseInt(quantity, 10);
      const newQuantity = isNaN(parsedQuantity) ? 1 : parsedQuantity;

      const lock = await redlock.acquire([`lock:product:${prodId}`], 5000);
      try {
        const product = await prisma.product.findUnique({ where: { id: prodId } });
        if (!product) {
          return res.status(404).json({ error: "Product not found" });
        }

        const existingCartItem = await prisma.cartItem.findUnique({
          where: { userId_productId: { userId, productId: prodId } }
        });

        const currentQty = existingCartItem ? existingCartItem.quantity : 0;
        const targetQty = currentQty + newQuantity;
        const diff = targetQty - currentQty;

        if (diff > 0) {
          if (product.stockQuantity < diff) {
            return res.status(400).json({ error: "Not enough stock" });
          }
          // Reserve stock
          await prisma.product.update({
            where: { id: prodId },
            data: { stockQuantity: { decrement: diff } }
          });
        } else if (diff < 0) {
          // Release stock
          await prisma.product.update({
            where: { id: prodId },
            data: { stockQuantity: { increment: Math.abs(diff) } }
          });
        }

        // Update cart item
        if (targetQty <= 0) {
          if (existingCartItem) {
            await prisma.cartItem.delete({
              where: { userId_productId: { userId, productId: prodId } }
            });
          }
          
          // Delete reservation key
          const keys = await redis.keys(`reservation:${userId}:${prodId}:*`);
          if (keys.length > 0) {
            await redis.del(...keys);
          }
          
          return res.json({ message: "Item removed from cart", quantity: 0 });
        }

        const cartItem = await prisma.cartItem.upsert({
          where: { userId_productId: { userId, productId: prodId } },
          update: { quantity: targetQty },
          create: { userId, productId: prodId, quantity: targetQty }
        });

        // Set Redis TTL for the reservation
        const keys = await redis.keys(`reservation:${userId}:${prodId}:*`);
        if (keys.length > 0) {
          await redis.del(...keys);
        }
        
        // Set new TTL for 15 minutes
        await redis.setex(`reservation:${userId}:${prodId}:${targetQty}`, 900, "reserved");

        res.json(cartItem);
      } finally {
        await lock.release();
      }
    } catch (error: any) {
      console.error("Failed to update cart:", error);
      res.status(500).json({ 
        error: "Failed to update cart", 
        message: error.message,
        code: error.code,
        meta: error.meta
      });
    }
  });

  app.delete("/api/users/:userId/cart/:productId", requireOwnerOrAdmin, async (req, res) => {
    try {
      const userId = req.params.userId as string;
      const productId = req.params.productId as string;

      // Ensure target user exists
      const targetUser = await prisma.user.findUnique({ where: { id: userId } });
      if (!targetUser) {
        return res.status(404).json({ error: "User not found" });
      }

      const lock = await redlock.acquire([`lock:product:${productId}`], 5000);
      try {
        const existingCartItem = await prisma.cartItem.findUnique({
          where: { userId_productId: { userId, productId } }
        });

        if (existingCartItem) {
          // Release stock
          await prisma.product.update({
            where: { id: productId },
            data: { stockQuantity: { increment: existingCartItem.quantity } }
          });

          await prisma.cartItem.delete({ where: { userId_productId: { userId, productId } } });

          // Delete reservation key
          const keys = await redis.keys(`reservation:${userId}:${productId}:*`);
          if (keys.length > 0) {
            await redis.del(...keys);
          }
        }
        res.status(204).send();
      } finally {
        await lock.release();
      }
    } catch (error) {
      console.error("Failed to remove from cart:", error);
      res.status(500).json({ error: "Failed to remove from cart" });
    }
  });

  // --- WISHLIST (PROTECTED) ---
  app.get("/api/users/:userId/wishlist", requireOwnerOrAdmin, async (req, res) => {
    try {
      const userId = req.params.userId as string;
      const items = await prisma.wishlistItem.findMany({
        where: { userId },
        include: { product: true }
      });
      res.json(items);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch wishlist" });
    }
  });

  app.post("/api/users/:userId/wishlist", requireOwnerOrAdmin, async (req, res) => {
    try {
      const userId = req.params.userId as string;
      const { productId } = req.body;

      // Ensure target user exists
      const targetUser = await prisma.user.findUnique({ where: { id: userId } });
      if (!targetUser) {
        return res.status(404).json({ error: "User not found" });
      }

      if (!productId) {
        return res.status(400).json({ error: "Product ID is required" });
      }

      // Ensure product exists
      const product = await prisma.product.findUnique({ where: { id: productId } });
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }

      const item = await prisma.wishlistItem.create({
        data: { userId, productId }
      });
      res.json(item);
    } catch (error) {
      res.status(500).json({ error: "Failed to add to wishlist" });
    }
  });

  app.delete("/api/users/:userId/wishlist/:productId", requireOwnerOrAdmin, async (req, res) => {
    try {
      const userId = req.params.userId as string;
      const productId = req.params.productId as string;
      await prisma.wishlistItem.delete({
        where: {
          userId_productId: { userId, productId }
        }
      });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to remove from wishlist" });
    }
  });

  // --- GDPR: DATA SUBJECT ACCESS REQUEST (DSAR) ---
  app.get("/api/users/me/data", requireAuth, async (req: any, res) => {
    try {
      const userId = req.user.userId;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          orders: {
            include: {
              items: true,
              invoices: {
                include: {
                  lines: true
                }
              }
            }
          },
          wishlist: {
            include: {
              product: true
            }
          },
          cart: {
            include: {
              product: true
            }
          }
        }
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Remove sensitive fields
      const { passwordHash, resetToken, resetTokenExpiry, ...safeUserData } = user;

      res.json(safeUserData);
    } catch (error) {
      console.error("Failed to export user data:", error);
      res.status(500).json({ error: "Failed to export user data" });
    }
  });

  // --- GDPR: ACCOUNT ANONYMIZATION (Right to be Forgotten) ---
  app.delete("/api/users/me", requireAuth, async (req: any, res) => {
    try {
      const userId = req.user.userId;
      
      // GDPR: Anonymize user data but keep orders/invoices for legal compliance
      // The logic must not perform a hard delete of financial records.
      const hash = crypto.randomBytes(4).toString('hex');
      const anonymizedEmail = `deleted-${userId}-${hash}@rokof.lv`;
      
      await prisma.$transaction(async (tx) => {
        // 0. Check for active orders - cannot delete if orders are in progress
        const activeOrders = await tx.order.findMany({
          where: {
            userId,
            status: { in: ['PAID', 'PROCESSING', 'IN_DELIVERY', 'SHIPPED'] }
          }
        });

        if (activeOrders.length > 0) {
          throw new Error("ACTIVE_ORDERS_EXIST");
        }

        // 1. Anonymize User record
        await tx.user.update({
          where: { id: userId },
          data: {
            email: anonymizedEmail,
            firstName: "Deleted",
            lastName: "User",
            phone: "00000000",
            companyName: null,
            regNo: null,
            vatNo: null,
            legalAddress: "Anonymized",
            physicalAddress: null,
            street: null,
            building: null,
            apartment: null,
            city: null,
            district: null,
            zipCode: null,
            country: null,
            bankName: null,
            swift: null,
            bankAccount: null,
            passwordHash: "ANONYMIZED_" + crypto.randomBytes(16).toString('hex'),
            resetToken: null,
            resetTokenExpiry: null,
            role: "CUSTOMER", // Revoke admin if any
          }
        });

        // 2. Delete non-essential PII (Wishlist, Cart)
        await tx.wishlistItem.deleteMany({ where: { userId } });
        await tx.cartItem.deleteMany({ where: { userId } });

        // 3. Anonymize Orders
        const orders = await tx.order.findMany({ where: { userId } });
        for (const order of orders) {
          let anonymizedCustomerInfo = null;
          if (order.customerInfo) {
            try {
              const info = JSON.parse(order.customerInfo);
              anonymizedCustomerInfo = JSON.stringify({
                ...info,
                email: anonymizedEmail,
                firstName: "Deleted",
                lastName: "User",
                phone: "00000000",
                companyName: info.companyName ? "Anonymized Company" : null,
                regNo: info.regNo ? "Anonymized" : null,
                vatNo: info.vatNo ? "Anonymized" : null,
                legalAddress: "Anonymized"
              });
            } catch (e) {
              anonymizedCustomerInfo = "Anonymized";
            }
          }

          await tx.order.update({
            where: { id: order.id },
            data: {
              deliveryAddress: "Anonymized",
              customerInfo: anonymizedCustomerInfo,
              qrCodeData: null // Might contain PII
            }
          });

          // 4. Anonymize Invoices
          await tx.invoice.updateMany({
            where: { orderId: order.id },
            data: {
              buyerName: "Deleted User",
              buyerFirstName: "Deleted",
              buyerLastName: "User",
              buyerEmail: anonymizedEmail,
              buyerPhone: "00000000",
              buyerAddress: "Anonymized",
              buyerRegNo: null,
              buyerVatNo: null,
              buyerBank: null,
              buyerSwift: null,
              buyerAccount: null,
              buyerSignatory: null
            }
          });
        }
      });

      res.json({ success: true, message: "Account anonymized successfully in accordance with GDPR" });
    } catch (error: any) {
      if (error.message === "ACTIVE_ORDERS_EXIST") {
        return res.status(400).json({ error: "Cannot delete account with active orders. Please wait for completion or contact support." });
      }
      console.error("Failed to anonymize account:", error);
      res.status(500).json({ error: "Failed to anonymize account" });
    }
  });

  // --- IMPORT API ---
  app.post("/api/import-xlsm", requireAdmin, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }

      const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = xlsx.utils.sheet_to_json(sheet) as any[];

      let createdCount = 0;
      let updatedCount = 0;
      let errorCount = 0;
      const errors: any[] = [];

      // Process in batches of 50 to optimize database performance
      const BATCH_SIZE = 50;
      for (let i = 0; i < data.length; i += BATCH_SIZE) {
        const batch = data.slice(i, i + BATCH_SIZE);
        
        await prisma.$transaction(async (tx) => {
          for (const [batchIndex, row] of batch.entries()) {
            const globalIndex = i + batchIndex;
            try {
              const sku = row["code"];
              const title = row["SIMBOLS / TIPS"];
              let rawPrice = row["CENA"];
              const stock = parseInt(row["PIEEJAMĪBA"], 10);
              const image = row["FOTO"];
              const description = row["Apraksts"];

              if (!sku) continue;

              let price = 0;
              if (typeof rawPrice === 'string') {
                rawPrice = rawPrice.replace(/€/g, '').replace(/,/g, '.').trim();
                price = parseFloat(rawPrice);
              } else if (typeof rawPrice === 'number') {
                price = rawPrice;
              }
              if (isNaN(price)) price = 0;

              let stockQuantity = isNaN(stock) ? 0 : stock;
              let unit = "pcs";
              if (title && title.toLowerCase().includes("strip")) unit = "m";

              const specs: any = { warranty: '3', weightPerMeter: 0 };
              if (title) {
                const parts = title.split('•').map((p: string) => p.trim());
                parts.forEach((part: string) => {
                  if (part.endsWith('V')) specs.voltage = part;
                  else if (part.endsWith('W')) specs.powerPerMeter = parseFloat(part);
                  else if (part.endsWith('K')) specs.colorTemperature = part;
                  else if (part.startsWith('IP')) specs.ipRating = part;
                  else if (part.endsWith('LM')) specs.luminousFlux = part;
                  else if (part.startsWith('RA')) specs.cri = part;
                  else if (part.endsWith('MM')) specs.width = part;
                });
              }

              const b2bPrice = price * 0.8;

              const productData = {
                sku: String(sku),
                titleLV: title || "",
                titleRU: title || "",
                titleEN: title || "",
                descriptionLV: description || null,
                descriptionRU: description || null,
                descriptionEN: description || null,
                images: JSON.stringify(image ? [image] : []),
                price: price,
                b2bPrice: b2bPrice,
                unit: unit,
                stockQuantity: stockQuantity,
                warrantyMonths: 36,
                specifications: JSON.stringify(specs)
              };

              const existing = await tx.product.findUnique({ where: { sku: String(sku) } });
              if (existing) {
                updatedCount++;
                
                // Preserve existing weightPerMeter if new one is 0
                let finalSpecs = specs;
                if (existing.specifications) {
                  try {
                    const existingSpecs = JSON.parse(existing.specifications);
                    if (specs.weightPerMeter === 0 && existingSpecs.weightPerMeter) {
                      finalSpecs.weightPerMeter = existingSpecs.weightPerMeter;
                    }
                    // Preserve other existing specs if needed, or just merge?
                    // For now, let's just preserve weight as that's the critical issue
                    finalSpecs = { ...existingSpecs, ...specs };
                    if (specs.weightPerMeter === 0 && existingSpecs.weightPerMeter) {
                        finalSpecs.weightPerMeter = existingSpecs.weightPerMeter;
                    }
                  } catch (e) {
                    console.error('Error parsing existing specs', e);
                  }
                }

                await tx.product.update({
                  where: { sku: String(sku) },
                  data: {
                    price: price,
                    stockQuantity: stockQuantity,
                    specifications: JSON.stringify(finalSpecs)
                  }
                });
              } else {
                createdCount++;
                await tx.product.create({ data: productData });
              }
            } catch (err: any) {
              errorCount++;
              errors.push({ row: globalIndex + 2, error: err.message });
            }
          }
        });
      }

      res.json({ 
        success: true, 
        createdCount, 
        updatedCount, 
        errorCount, 
        errors 
      });
    } catch (error) {
      console.error("Excel import error:", error);
      res.status(500).json({ error: "Failed to process file" });
    }
  });

  // --- ORDERS API ---
  app.get("/api/orders", requireAdmin, async (req, res) => {
    try {
      const orders = await prisma.order.findMany({
        include: { user: true, items: true },
        orderBy: { createdAt: 'desc' }
      });
      
      const parsedOrders = orders.map(o => ({
        ...o,
        customerInfo: o.customerInfo ? JSON.parse(o.customerInfo) : null
      }));
      res.json(parsedOrders);
    } catch (error) {
      console.error("Failed to fetch orders:", error);
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  });

  // --- ORDERS API ---

  app.post("/api/orders", async (req, res) => {
    try {
      const orderData = req.body;
      
      const { 
        userId, 
        items, 
        deliveryCost, 
        deliveryMethod, 
        shippingAddress, 
        stationId,
        customerInfo,
        comment,
        language,
        idempotencyKey,
        country,
        couponCode
      } = orderData;

      // 1. Idempotency Check
      if (idempotencyKey) {
        const existingOrder = await prisma.order.findUnique({
          where: { idempotencyKey },
          include: { items: true }
        });
        if (existingOrder) {
          return res.json(existingOrder);
        }
      }

      let finalUserId = userId === 'guest' ? null : userId;
      let userType = 'INDIVIDUAL';
      if (finalUserId) {
        const user = await prisma.user.findUnique({ where: { id: finalUserId } });
        if (user) userType = user.type;
      }

      // 2. Validate items
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "Order must contain at least one item" });
      }

      for (const item of items) {
        if (!item.quantity || item.quantity <= 0) {
          return res.status(400).json({ error: "Quantity must be strictly greater than 0" });
        }
      }

      // 3. Create Order with Transaction
      const order = await prisma.$transaction(async (tx) => {
        // A. Distributed Locking for Inventory
        // Sort keys lexicographically to prevent distributed deadlock
        const resourceKeys = items.map((item: any) => `lock:product:${item.id}`).sort();
        let lock;
        try {
          lock = await redlock.acquire(resourceKeys, 5000); // 5s lock
        } catch (e) {
          throw new Error('Could not acquire inventory lock. Please try again in a few seconds.');
        }

        try {
          // B. Generate Sequential Order Number using Sequence table
          const currentYear = new Date().getFullYear();
          const seqValue = await getNextSequence(`order_${currentYear}`, tx);
          const sequence = seqValue.toString().padStart(4, '0');
          const invoiceNumber = `ROK/${currentYear}-${sequence}`;

          // C. Fetch products to get specifications, verify stock, and recalculate prices
          const productIds = items.map((item: any) => item.id).filter((id: any) => id);
          const products = await tx.product.findMany({
            where: { id: { in: productIds } }
          });
          const productMap = new Map(products.map(p => [p.id, p]));

          let calculatedNetSum = 0;
          const orderItemsData = items.map((item: any) => {
            const product = productMap.get(item.id);
            if (!product) throw new Error(`Product SKU ${item.sku || item.id} not found`);
            
            if (product.stockQuantity < item.quantity) {
              throw new Error(`Insufficient stock for SKU ${product.sku}. Available: ${product.stockQuantity}, Requested: ${item.quantity}`);
            }

            // Secure Price Calculation on Backend
            let actualPrice = userType === 'BUSINESS' ? product.b2bPrice : product.price;
            if (actualPrice < 0) throw new Error("Price cannot be negative");

            const itemTotal = actualPrice * item.quantity;
            calculatedNetSum += itemTotal;

            let weight = 0;
            if (product.specifications) {
              try {
                const specs = JSON.parse(product.specifications);
                weight = Number(specs.weightPerMeter) || 0;
              } catch (e) {}
            }

            return {
              productId: product.id,
              title: product.titleLV || product.titleRU || product.titleEN || 'Unknown',
              image: product.images ? JSON.parse(product.images)[0] : null,
              quantity: item.quantity,
              priceAtPurchase: actualPrice,
              total: itemTotal,
              weightPerMeter: weight
            };
          });

          // D. Coupon Logic (Atomic Check-Then-Act)
          let discountAmount = 0;
          if (couponCode) {
            // Find coupon
            const coupon = await tx.coupon.findUnique({
              where: { code: couponCode }
            });

            if (!coupon) {
              throw new Error("Invalid coupon code");
            }
            if (!coupon.isActive) {
              throw new Error("Coupon is no longer active");
            }

            // Atomically increment usage count
            const updatedCoupon = await tx.coupon.update({
              where: { id: coupon.id },
              data: { usageCount: { increment: 1 } }
            });

            // Check if it exceeded the limit after incrementing (rolls back if true)
            if (updatedCoupon.maxUsage !== null && updatedCoupon.usageCount > updatedCoupon.maxUsage) {
              throw new Error("Coupon usage limit reached");
            }

            // Calculate discount
            if (coupon.discountType === 'PERCENTAGE') {
              discountAmount = calculatedNetSum * (coupon.value / 100);
            } else if (coupon.discountType === 'FIXED') {
              discountAmount = coupon.value;
            }

            // Prevent negative subtotal
            if (discountAmount > calculatedNetSum) {
              discountAmount = calculatedNetSum;
            }
          }

          const finalSubtotal = calculatedNetSum - discountAmount;
          
          // E. OSS Tax Calculation
          const vatRate = getVatRate(country);
          const vatAmount = finalSubtotal * vatRate;
          const safeDeliveryCost = Math.max(0, Number(deliveryCost) || 0); // Prevent negative delivery cost
          const grossTotal = finalSubtotal + vatAmount + safeDeliveryCost;

          // F. Create the order
          const newOrder = await tx.order.create({
            data: {
              userId: finalUserId,
              invoiceNumber: invoiceNumber,
              idempotencyKey: idempotencyKey || null,
              subtotal: finalSubtotal,
              vatAmount: vatAmount,
              totalAmount: grossTotal,
              deliveryCost: safeDeliveryCost,
              deliveryMethod: deliveryMethod || 'PICKUP',
              deliveryAddress: shippingAddress || 'N/A',
              stationId: stationId || null,
              customerInfo: JSON.stringify(customerInfo),
              status: 'NEW',
              items: {
                create: orderItemsData
              }
            },
            include: { items: true }
          });

          // G. Atomic Stock Update with Over-sell Protection and Reservation Handling
          const keysToDelete: string[] = [];
          for (const item of orderItemsData) {
            let reservedQty = 0;
            let reservationKeys: string[] = [];
            
            if (finalUserId) {
              reservationKeys = await redis.keys(`reservation:${finalUserId}:${item.productId}:*`);
              if (reservationKeys.length > 0) {
                // Extract quantity from the first key (there should only be one)
                const parts = reservationKeys[0].split(':');
                if (parts.length >= 4) {
                  reservedQty = parseInt(parts[3], 10);
                }
              }
            }

            const diff = item.quantity - reservedQty;

            if (diff > 0) {
              // Need to decrement more stock
              await tx.product.update({
                where: { id: item.productId },
                data: { stockQuantity: { decrement: diff } }
              });
            } else if (diff < 0) {
              // Need to restore some stock
              await tx.product.update({
                where: { id: item.productId },
                data: { stockQuantity: { increment: Math.abs(diff) } }
              });
            }

            // Collect reservation keys to delete after transaction succeeds
            if (reservationKeys.length > 0) {
              keysToDelete.push(...reservationKeys);
            }
          }

          // Clear user's cart if they were logged in
          if (finalUserId) {
            await tx.cartItem.deleteMany({
              where: { userId: finalUserId }
            });
          }

          // H. Generate Prepayment Invoice automatically
          await createInvoiceFromOrder(newOrder.id, tx as any);

          return { newOrder, keysToDelete };
        } finally {
          // Release the lock
          if (lock) await lock.release();
        }
      }, {
        timeout: 10000 // 10s timeout for high-load
      });

      // Delete reservation keys now that transaction succeeded
      if (order.keysToDelete && order.keysToDelete.length > 0) {
        await redis.del(...order.keysToDelete);
      }

      const newOrder = order.newOrder;

      // --- GENERATE PDF (Non-blocking) ---
      // Run asynchronously to avoid blocking the event loop
      setImmediate(async () => {
        try {
          const invoice = await prisma.invoice.findFirst({
            where: { orderId: newOrder.id, documentType: 'prepayment' },
            include: { lines: true, order: true }
          });
          
          if (invoice) {
            const pdfBuffer = await generateInvoicePdfData(mapInvoice(invoice) as any);
            const fileName = `Prepayment_${newOrder.invoiceNumber!.replace('/', '_')}.pdf`;
            const uploadDir = path.join(process.cwd(), 'public', 'uploads');
            if (!fs.existsSync(uploadDir)) {
              fs.mkdirSync(uploadDir, { recursive: true });
            }
            const filePath = path.join(uploadDir, fileName);
            fs.writeFileSync(filePath, pdfBuffer);
            
            await prisma.order.update({
              where: { id: newOrder.id },
              data: { prepaymentInvoiceUrl: `/uploads/${fileName}` }
            });
          }
        } catch (pdfError) {
          console.error("Failed to generate prepayment PDF in background:", pdfError);
        }
      });

      res.json(newOrder);
    } catch (error) {
      console.error("Order creation failed:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to create order" });
    }
  });

  // --- STRIPE PAYMENTS ---
  app.post("/api/payments/create-intent", async (req, res) => {
    try {
      const { orderId } = req.body;
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { user: true }
      });

      if (!order) return res.status(404).json({ error: "Order not found" });

      // Create Stripe Payment Intent with Idempotency
      const intent = await stripe.paymentIntents.create({
        amount: Math.round(order.totalAmount * 100), // cents
        currency: 'eur',
        metadata: { orderId: order.id },
        receipt_email: order.user?.email || undefined,
      }, {
        idempotencyKey: `payment_intent_${order.id}`
      });

      await prisma.order.update({
        where: { id: order.id },
        data: { stripePaymentIntentId: intent.id }
      });

      res.json({ clientSecret: intent.client_secret });
    } catch (error) {
      console.error("Stripe error:", error);
      res.status(500).json({ error: "Failed to create payment intent" });
    }
  });

  // --- GUEST WITHDRAWAL (EU 2-STEP) ---
  app.post("/api/orders/withdraw", async (req, res) => {
    try {
      const { orderId, email } = req.body;

      if (!orderId || !email) {
        return res.status(400).json({ error: "Order ID and Email are required" });
      }

      // Find order by ID or invoiceNumber
      const order = await prisma.order.findFirst({
        where: {
          OR: [
            { id: orderId },
            { invoiceNumber: orderId }
          ]
        },
        include: { user: true }
      });

      if (!order) {
        return res.status(404).json({ error: "Order not found or email mismatch" });
      }

      // Verify email
      let orderEmail = order.user?.email;
      if (!orderEmail && order.customerInfo) {
        try {
          const ci = JSON.parse(order.customerInfo);
          orderEmail = ci.email;
        } catch (e) {}
      }

      if (!orderEmail || orderEmail.toLowerCase() !== email.toLowerCase()) {
        return res.status(404).json({ error: "Order not found or email mismatch" });
      }

      // Check if within 14 days
      const diffDays = (new Date().getTime() - new Date(order.createdAt).getTime()) / (1000 * 3600 * 24);
      if (diffDays > 14) {
        return res.status(400).json({ error: "Withdrawal period (14 days) has expired" });
      }

      // Update order status and create withdrawal record
      await prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: { status: 'CANCELLED' }
        });

        await tx.orderWithdrawal.create({
          data: {
            orderId: order.id,
            reason: 'Guest Withdrawal (EU 2-Step)',
            status: 'CONFIRMED',
            confirmedAt: new Date()
          }
        });
      });

      // Generate and email PDF confirmation in background (Durable Medium)
      setImmediate(async () => {
        try {
          console.log(`Generating withdrawal PDF for order ${order.id}`);
          
          // Generate simple PDF
          const doc = new PDFDocument({ margin: 50 });
          const buffers: Buffer[] = [];
          
          doc.on('data', buffers.push.bind(buffers));
          
          doc.fontSize(20).text('Withdrawal Confirmation', { align: 'center' });
          doc.moveDown();
          doc.fontSize(12).text(`Order ID: ${order.invoiceNumber || order.id}`);
          doc.text(`Date of Withdrawal: ${new Date().toLocaleDateString()}`);
          doc.text(`Email: ${email}`);
          doc.moveDown();
          doc.text('Your withdrawal request has been successfully processed in accordance with EU Directive (EU) 2023/2673.');
          doc.text('The order has been cancelled.');
          
          doc.end();

          const pdfBuffer = await new Promise<Buffer>((resolve) => {
            doc.on('end', () => resolve(Buffer.concat(buffers)));
          });

          // Send email
          await transporter.sendMail({
            from: `"ROKOF" <${ADMIN_EMAIL}>`,
            to: email,
            subject: `Withdrawal Confirmation - Order ${order.invoiceNumber || order.id}`,
            text: `Dear Customer,\n\nYour withdrawal request for order ${order.invoiceNumber || order.id} has been processed.\nPlease find the confirmation attached as a PDF document.\n\nBest regards,\nROKOF Team`,
            attachments: [
              {
                filename: `Withdrawal_${order.invoiceNumber || order.id}.pdf`,
                content: pdfBuffer,
                contentType: 'application/pdf'
              }
            ]
          });
          
          console.log(`Withdrawal confirmation email sent to ${email}`);
        } catch (err) {
          console.error("Failed to send withdrawal confirmation email:", err);
        }
      });

      res.json({ success: true, message: "Withdrawal confirmed" });
    } catch (error) {
      console.error("Guest withdrawal error:", error);
      res.status(500).json({ error: "Failed to process withdrawal" });
    }
  });

  // --- AUTHENTICATED WITHDRAWAL ---
  app.post("/api/orders/:id/withdraw", requireAuth, async (req: any, res: any) => {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      const userId = req.user.id;

      const order = await prisma.order.findUnique({ where: { id } });
      if (!order) return res.status(404).json({ error: "Order not found" });

      // Security Fix: IDOR Prevention
      if (order.userId !== userId) {
        return res.status(403).json({ error: "Forbidden: You do not own this order" });
      }

      // Check if within 14 days
      const diffDays = (new Date().getTime() - new Date(order.createdAt).getTime()) / (1000 * 3600 * 24);
      if (diffDays > 14) {
        return res.status(400).json({ error: "Withdrawal period (14 days) has expired" });
      }

      const withdrawal = await prisma.orderWithdrawal.create({
        data: {
          orderId: id,
          reason,
          status: 'REQUESTED'
        }
      });

      // Notify Admin (Mock)
      console.log(`Withdrawal requested for order ${order.invoiceNumber || order.id}`);

      res.json(withdrawal);
    } catch (error) {
      console.error("Withdrawal error:", error);
      res.status(500).json({ error: "Failed to request withdrawal" });
    }
  });

  app.patch("/api/withdrawals/:id/confirm", requireAdmin, async (req, res) => {
    try {
      const id = req.params.id as string;
      const withdrawal = await prisma.orderWithdrawal.update({
        where: { id },
        data: {
          status: 'CONFIRMED',
          confirmedAt: new Date()
        }
      });

      res.json(withdrawal);
    } catch (error) {
      res.status(500).json({ error: "Failed to confirm withdrawal" });
    }
  });

  app.put("/api/orders/:id/tracking", requireAdmin, async (req, res) => {
    try {
      const id = req.params.id as string;
      const { trackingNumber } = req.body;
      
      const order = await prisma.order.update({
        where: { id },
        data: { 
          trackingNumber,
          status: 'SHIPPED'
        },
        include: { user: true, items: true }
      });

      // Send tracking email
      if (order.user?.email && trackingNumber) {
        let trackingLink = '';
        const method = (order.deliveryMethod || '').toLowerCase();
        
        if (method.includes('omniva')) {
          trackingLink = `https://www.omniva.lv/track?number=${trackingNumber}`;
        } else if (method.includes('dpd')) {
          trackingLink = `https://www.dpd.com/lv/lv/sanemsana/sutijumu-izsekosana/?parcel_number=${trackingNumber}`;
        }

        if (trackingLink) {
          try {
            const customerName = order.user.firstName || order.user.companyName || "Klients";
            const isLV = (order.user.language || 'lv') === 'lv';
            
            await transporter.sendMail({
              from: `"ROKOF" <${ADMIN_EMAIL}>`,
              to: order.user.email,
              subject: isLV ? `Jūsu pasūtījums ir izsūtīts!` : `Your order has been shipped!`,
              text: isLV 
                ? `Labdien, ${customerName}!\n\nJūsu pasūtījums ir izsūtīts. Jūs varat tam izsekot šeit:\n${trackingLink}\n\nAr cieņu,\nROKOF.LV`
                : `Hello, ${customerName}!\n\nYour order has been shipped. You can track it here:\n${trackingLink}\n\nBest regards,\nROKOF.LV`
            });
          } catch (emailError) {
            console.error("Failed to send tracking email:", emailError);
          }
        }
      }
      
      res.json(order);
    } catch (error) {
      console.error("Failed to update order tracking:", error);
      res.status(500).json({ error: "Failed to update order tracking" });
    }
  });

  app.put("/api/orders/:id/admin-update", requireAdmin, async (req, res) => {
    try {
      const id = req.params.id as string;
      const { internalNote, trackingNumber } = req.body;
      
      const order = await prisma.order.update({
        where: { id },
        data: { 
          internalNote,
          trackingNumber
        }
      });
      
      res.json(order);
    } catch (error) {
      console.error("Failed to update order admin fields:", error);
      res.status(500).json({ error: "Failed to update order admin fields" });
    }
  });

  app.patch("/api/orders/:id/status", requireAdmin, async (req, res) => {
    try {
      const id = req.params.id as string;
      const { status, isPaid } = req.body;

      const order = await prisma.order.findUnique({
        where: { id },
        include: { user: true, items: true }
      });

      if (!order) return res.status(404).json({ error: "Order not found" });

      const oldStatus = order.status;
      const oldIsPaid = order.isPaid;

      // Update data (payment or status)
      const updatedOrder: any = await prisma.order.update({
        where: { id },
        data: { 
          status: status || order.status,
          isPaid: isPaid !== undefined ? isPaid : order.isPaid,
          paidAt: (isPaid === true && !oldIsPaid) ? new Date() : order.paidAt
        },
        include: { user: true, items: true }
      });

      // LOGIC: If order is moved to SHIPPED and it is paid — generate final invoice
      if (status === 'SHIPPED' && updatedOrder.isPaid) {
        try {
          // 1. Generate Invoice Record and PDF
          const invoice = await createInvoiceFromOrder(id, prisma);
          const pdfBuffer = await generateInvoicePdfData(invoice);
          
          const fileName = `Nakaladna_RKF_${updatedOrder.id}.pdf`;
          const uploadDir = path.join(process.cwd(), 'public', 'uploads');
          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }
          const filePath = path.join(uploadDir, fileName);
          
          fs.writeFileSync(filePath, pdfBuffer);

          // 2. Update invoice URL and numbers in DB
          await prisma.order.update({
            where: { id },
            data: { 
              invoiceUrl: `/uploads/${fileName}`,
              rkfInvoiceNumber: invoice.documentNumber,
              pavadzimeNumber: invoice.documentNumber
            }
          });

          // 3. Send to client
          if (updatedOrder.user?.email) {
            await transporter.sendMail({
              from: `"ROKOF" <${ADMIN_EMAIL}>`,
              to: updatedOrder.user.email,
              subject: `Jūsu pavadzīme pasūtījumam ${updatedOrder.id}`,
              text: `Labdien! Jūsu pasūtījums ir izsūtīts. Pielikumā pievienota apmaksāta pavadzīme.`,
              attachments: [{ filename: fileName, path: filePath }]
            });
          }
        } catch (genError) {
          console.error("Failed to generate/send final invoice:", genError);
        }
      }

      // Handle other status changes
      if (status === 'IN_DELIVERY' && oldStatus !== 'IN_DELIVERY') {
        await sendInDeliveryEmail(updatedOrder);
      }

      // Warranty calculation if paid
      if (updatedOrder.isPaid && !oldIsPaid) {
        for (const item of updatedOrder.items) {
          if (!item.warrantyUntil) {
            const product = await prisma.product.findUnique({ where: { id: item.productId } });
            if (product) {
              const warrantyMonths = product.warrantyMonths || 36;
              const warrantyUntil = new Date();
              warrantyUntil.setMonth(warrantyUntil.getMonth() + warrantyMonths);
              await prisma.orderItem.update({
                where: { id: item.id },
                data: { warrantyUntil }
              });
            }
          }
        }
      }

      res.json(updatedOrder);
    } catch (error) {
      console.error("Failed to update order status:", error);
      res.status(500).json({ error: "Failed to update order status" });
    }
  });

  // SEND PRE-INVOICE with QR Code
  app.post("/api/orders/:id/send-pre-invoice", requireAdmin, async (req, res) => {
    try {
      const id = req.params.id as string;
      const order: any = await prisma.order.findUnique({ 
        where: { id },
        include: { user: true, items: true }
      });
      
      if (!order) return res.status(404).json({ error: "Order not found" });

      // Update order status first
      await prisma.order.update({
        where: { id },
        data: { 
          status: 'NEW',
          preInvoiceSentAt: new Date()
        }
      });

      // Send Email
      try {
        if (order.prepaymentInvoiceUrl) {
          await transporter.sendMail({
            from: `"ROKOF" <${ADMIN_EMAIL}>`,
            to: order.user.email,
            subject: `Priekšapmaksas rēķins ${order.invoiceNumber || order.id}`,
            text: generateOrderEmailText(order),
            attachments: [
              {
                filename: `Rekins_${(order.invoiceNumber || order.id).replace(/\//g, '-')}.pdf`,
                path: path.join(process.cwd(), 'public', order.prepaymentInvoiceUrl)
              }
            ]
          });
        } else {
          // Generate PDF
          const invoice = await createInvoiceFromOrder(order.id, prisma);
          const pdfData = await generateInvoicePdfData(invoice as any);
          
          await transporter.sendMail({
            from: `"ROKOF" <${ADMIN_EMAIL}>`,
            to: order.user.email,
            subject: `Priekšapmaksas rēķins ${order.invoiceNumber || order.id}`,
            text: generateOrderEmailText(order),
            attachments: [{ filename: `Prieksapmaksas_Rekins_${(order.invoiceNumber || order.id).replace(/\//g, '-')}.pdf`, content: pdfData }]
          });
        }
      } catch (emailError) {
        console.error("Failed to send pre-invoice email:", emailError);
        // Continue to return success since status was updated
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Failed to send pre-invoice:", error);
      res.status(500).json({ error: "Failed to send pre-invoice" });
    }
  });

  app.delete("/api/orders/cleanup", requireAdmin, async (req, res) => {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const oldOrders = await prisma.order.findMany({
        where: {
          createdAt: { lt: sevenDaysAgo },
          status: 'NEW'
        },
        select: { id: true }
      });

      const orderIds = oldOrders.map(o => o.id);

      if (orderIds.length > 0) {
        console.log("Deleting old orders:", orderIds);
        await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      }

      res.json({ success: true, count: orderIds.length });
    } catch (error) {
      console.error("Failed to cleanup orders:", error);
      res.status(500).json({ error: "Failed to cleanup orders" });
    }
  });

  app.delete("/api/orders/:id", requireAdmin, async (req, res) => {
    try {
      const id = req.params.id as string;
      await prisma.orderItem.deleteMany({ where: { orderId: id } }); // Delete items first
      await prisma.order.delete({ where: { id } });
      res.json({ success: true });
    } catch (error) {
      console.error("Failed to delete order:", error);
      res.status(500).json({ error: "Failed to delete order" });
    }
  });

  // GENERATE FINAL INVOICE (RKF)
  app.post("/api/orders/:id/generate-rkf", requireAdmin, async (req, res) => {
    try {
      const id = req.params.id as string;
      
      const order: any = await prisma.order.findUnique({ 
        where: { id },
        include: { user: true, items: true }
      });
      
      if (!order) return res.status(404).json({ error: "Order not found" });
      
      let rkfNumber = order.rkfInvoiceNumber;

      if (!rkfNumber) {
        // Use transaction to ensure sequence integrity
        await prisma.$transaction(async (tx) => {
          const count = await tx.order.count({
            where: { rkfInvoiceNumber: { not: null } }
          });
          const nextNumber = count + 1;
          rkfNumber = `RKF-${nextNumber.toString().padStart(4, '0')}`;

          await tx.order.update({
            where: { id },
            data: { 
              rkfInvoiceNumber: rkfNumber,
              status: 'SHIPPED'
            }
          });

          // Update warranty dates
          for (const item of order.items) {
             const product = await tx.product.findUnique({ where: { id: item.productId } });
             if (product) {
               const warrantyMonths = product.warrantyMonths || 36;
               const endsAt = new Date();
               endsAt.setMonth(endsAt.getMonth() + warrantyMonths);
               
               await tx.orderItem.update({
                 where: { id: item.id },
                 data: { warrantyUntil: endsAt }
               });
             }
          }
        });
      }
      
      // Re-fetch updated order
      const updatedOrder: any = await prisma.order.findUnique({
        where: { id },
        include: { user: true, items: true }
      });

      // Send Email
      try {
        if (updatedOrder.invoiceUrl) {
          await transporter.sendMail({
            from: `"ROKOF" <${ADMIN_EMAIL}>`,
            to: updatedOrder.user.email,
            subject: `Pavadzīme-Rēķins ${rkfNumber}`,
            text: generateOrderEmailText(updatedOrder),
            attachments: [
              {
                filename: `Pavadzime_${rkfNumber}.pdf`,
                path: path.join(process.cwd(), 'public', updatedOrder.invoiceUrl)
              }
            ]
          });
        } else {
          // Generate PDF
          const invoice = await createInvoiceFromOrder(updatedOrder.id, prisma);
          const pdfData = await generateInvoicePdfData(invoice as any);
          
          await transporter.sendMail({
            from: `"ROKOF" <${ADMIN_EMAIL}>`,
            to: updatedOrder.user.email,
            subject: `Pavadzīme-Rēķins ${rkfNumber}`,
            text: generateOrderEmailText(updatedOrder),
            attachments: [{ filename: `Pavadzime_${rkfNumber}.pdf`, content: pdfData }]
          });
        }
      } catch (emailError) {
        console.error("Failed to send RKF email:", emailError);
      }

      res.json({ success: true, rkfInvoiceNumber: rkfNumber });
    } catch (error) {
      console.error("Failed to generate RKF invoice:", error);
      res.status(500).json({ error: "Failed to generate RKF invoice" });
    }
  });

  // PRINT SHIPPING LABEL (Stub)
  app.post("/api/orders/:id/shipping-label", requireAdmin, async (req, res) => {
    try {
      const id = req.params.id as string;
      const order: any = await prisma.order.findUnique({ where: { id }, include: { user: true } });
      if (!order) return res.status(404).json({ error: "Order not found" });

      // Generate a simple PDF label
      const doc = new PDFDocument({ size: [288, 432] }); // 4x6 inch label
      const buffers: Buffer[] = [];
      doc.on('data', buffers.push.bind(buffers));

      const fontBuffer = await getRobotoFont();
      doc.registerFont('Roboto', fontBuffer);
      doc.font('Roboto');

      doc.fontSize(14).text('SHIPPING LABEL', { align: 'center' });
      doc.moveDown();
      doc.fontSize(10).text(`FROM: ${COMPANY_DETAILS.name}`);
      doc.text(COMPANY_DETAILS.address);
      doc.moveDown();
      doc.text(`TO: ${order.user.firstName} ${order.user.lastName}`);
      doc.text(`${order.deliveryAddress}`);
      doc.moveDown();
      doc.text(`ORDER: ${order.invoiceNumber || order.id}`);
      doc.text(`WEIGHT: 2.5 kg (Est.)`);
      doc.moveDown();
      doc.fontSize(12).text(`${order.deliveryMethod}`, { align: 'center', underline: true });

      doc.end();
      await new Promise<void>((resolve, reject) => {
        doc.on('end', resolve);
        doc.on('error', reject);
      });
      const pdfData = Buffer.concat(buffers);

      res.setHeader('Content-Type', 'application/pdf');
      res.send(pdfData);

    } catch (error) {
      console.error("Failed to generate shipping label:", error);
      res.status(500).json({ error: "Failed to generate shipping label" });
    }
  });

  // Global Error Handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("Unhandled error:", err);
    
    // Handle Multer errors
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: "File too large" });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: "Unexpected file field" });
    }

    res.status(err.status || 500).json({ 
      error: err.message || "Internal Server Error",
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  });

  if (process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else if (process.env.NODE_ENV !== "test") {
    app.use(express.static("dist"));
  }

  if (process.env.NODE_ENV !== 'test') {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }
}

export const serverPromise = startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
