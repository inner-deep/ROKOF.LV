
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const secret = process.env.JWT_SECRET;
console.log('JWT_SECRET length:', secret ? secret.length : 'UNDEFINED');

if (secret) {
  const payload = { userId: 'test-id', role: 'ADMIN', email: 'pavels@pzka.lv' };
  const token = jwt.sign(payload, secret, { expiresIn: '1h' });
  console.log('Generated Token:', token);

  try {
    const decoded = jwt.verify(token, secret);
    console.log('Decoded successfully:', decoded);
  } catch (err) {
    console.error('Verification failed:', err.message);
  }
}
