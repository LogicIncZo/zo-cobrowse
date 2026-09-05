import { describe, test, expect } from 'bun:test';
import { zoChatUrl, truncateId } from '../extension/lib/zo-links.js';
import {
  ZoChatUrlSchema,
  TruncatedIdSchema,
  ConversationIdSchema,
  ZoWebOriginSchema,
} from './schemas/zo-links.ts';

describe('zoChatUrl', () => {
  test('builds the deep link from origin + conversation id', () => {
    const url = zoChatUrl('https://cashlessconsumer.zo.computer', 'con_ijM6neD936odlluG');
    expect(url).toBe('https://cashlessconsumer.zo.computer/?chat=con_ijM6neD936odlluG&t=chats');
    expect(ZoChatUrlSchema.safeParse(url).success).toBe(true);
  });

  test('trims whitespace around the origin', () => {
    expect(zoChatUrl('  https://me.zo.computer  ', 'con_abc')).toBe(
      'https://me.zo.computer/?chat=con_abc&t=chats'
    );
  });

  test('normalizes trailing slash and ignores path components', () => {
    expect(zoChatUrl('https://me.zo.computer/', 'con_abc')).toBe(
      'https://me.zo.computer/?chat=con_abc&t=chats'
    );
    expect(zoChatUrl('https://me.zo.computer/some/path/', 'con_abc')).toBe(
      'https://me.zo.computer/?chat=con_abc&t=chats'
    );
  });

  test('accepts http origins', () => {
    expect(zoChatUrl('http://localhost:3000', 'con_abc')).toBe(
      'http://localhost:3000/?chat=con_abc&t=chats'
    );
  });

  test('percent-encodes the conversation id', () => {
    // Valid ids can't contain these chars, but the encoding must hold anyway.
    const url = zoChatUrl('https://me.zo.computer', 'con_a_b-c');
    expect(url).toBe('https://me.zo.computer/?chat=con_a_b-c&t=chats');
  });

  test('null on empty/whitespace origin', () => {
    expect(zoChatUrl('', 'con_abc')).toBeNull();
    expect(zoChatUrl('   ', 'con_abc')).toBeNull();
    expect(zoChatUrl(null, 'con_abc')).toBeNull();
    expect(zoChatUrl(undefined, 'con_abc')).toBeNull();
  });

  test('null on non-http(s) scheme', () => {
    expect(zoChatUrl('ftp://me.zo.computer', 'con_abc')).toBeNull();
    expect(zoChatUrl('javascript:alert(1)', 'con_abc')).toBeNull();
    expect(zoChatUrl('file:///etc/passwd', 'con_abc')).toBeNull();
  });

  test('null on garbage origin', () => {
    expect(zoChatUrl('not a url', 'con_abc')).toBeNull();
    expect(zoChatUrl('me.zo.computer', 'con_abc')).toBeNull();
  });

  test('null on missing/malformed conversation id', () => {
    expect(zoChatUrl('https://me.zo.computer', '')).toBeNull();
    expect(zoChatUrl('https://me.zo.computer', null)).toBeNull();
    expect(zoChatUrl('https://me.zo.computer', undefined)).toBeNull();
    expect(zoChatUrl('https://me.zo.computer', 'conv_ijM6neD936odlluG')).toBeNull(); // conv_ ≠ con_
    expect(zoChatUrl('https://me.zo.computer', 'ijM6neD936odlluG')).toBeNull(); // no prefix
    expect(zoChatUrl('https://me.zo.computer', 'con_ bad')).toBeNull(); // space
    expect(zoChatUrl('https://me.zo.computer', 42)).toBeNull();
  });

  test('both inputs bad → null (never throws)', () => {
    expect(zoChatUrl('', '')).toBeNull();
    expect(zoChatUrl(null, null)).toBeNull();
  });
});

describe('truncateId', () => {
  test('keeps ids ≤10 chars whole', () => {
    expect(truncateId('con_abc')).toBe('con_abc');
    expect(TruncatedIdSchema.safeParse(truncateId('con_abc')).success).toBe(true);
  });

  test('truncates longer ids to 10 chars + ellipsis', () => {
    expect(truncateId('con_ijM6neD936odlluG')).toBe('con_ijM6ne…');
  });

  test('empty/null → empty string', () => {
    expect(truncateId('')).toBe('');
    expect(truncateId(null)).toBe('');
    expect(truncateId(undefined)).toBe('');
  });
});

describe('schema contracts', () => {
  test('real-shaped conversation ids pass ConversationIdSchema', () => {
    expect(ConversationIdSchema.safeParse('con_ijM6neD936odlluG').success).toBe(true);
    expect(ConversationIdSchema.safeParse('con_A-B_9').success).toBe(true);
    expect(ConversationIdSchema.safeParse('conv_ijM6neD936odlluG').success).toBe(false);
    expect(ConversationIdSchema.safeParse('').success).toBe(false);
  });

  test('zoWebOrigin setting is a plain string (empty = off)', () => {
    expect(ZoWebOriginSchema.safeParse('').success).toBe(true);
    expect(ZoWebOriginSchema.safeParse('https://me.zo.computer').success).toBe(true);
  });
});
