import { describe, it, expect } from 'vitest';
import { explain } from '../src/sdk/meaning.js';

describe('a payment prompt Safaricom refused for its credentials', () => {
  it('says it is most likely the passkey, and where to fix it', () => {
    const ex = explain('stk', '4999', 'Wrong credentials');
    expect(ex.safaricomSaid).toBe('Wrong credentials');
    expect(ex.meaning).toContain('passkey that does not match this paybill');
    expect(ex.whatToDo).toContain('press Prove');
  });
});
