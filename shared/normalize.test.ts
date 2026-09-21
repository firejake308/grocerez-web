import { describe, it, expect } from 'vitest';
import { tokenize, tokensMatch, singularize, nameTokens, brandKey, diceSimilarity } from './normalize';

describe('tokensMatch', () => {
  it('matches equal tokens and prefixes', () => {
    expect(tokensMatch('egg', 'eggs')).toBe(true);
    expect(tokensMatch('cookies', 'cook')).toBe(true);
    expect(tokensMatch('egg', 'veggie')).toBe(false);
  });

  it('enforces a minimum shared prefix when asked', () => {
    expect(tokensMatch('egg', 'eggs', 4)).toBe(false);
    expect(tokensMatch('foam', 'foaming', 4)).toBe(true);
  });

  it('does not let a stray single-letter token prefix-match every word', () => {
    expect(tokensMatch('apple', 'a')).toBe(false);
    expect(tokensMatch('a', 'apple')).toBe(false);
    expect(tokensMatch('a', 'a')).toBe(true);
  });
});

describe('singularize', () => {
  it('handles common grocery plurals consistently', () => {
    expect(singularize('cookies')).toBe('cookie');
    expect(singularize('berries')).toBe('berry');
    expect(singularize('blueberries')).toBe('blueberry');
    expect(singularize('eggs')).toBe('egg');
    expect(singularize('boxes')).toBe('box');
    expect(singularize('tomatoes')).toBe('tomato');
    expect(singularize('hummus')).toBe('hummus');
    expect(singularize('glass')).toBe('glass');
    expect(singularize('oz')).toBe('oz');
  });
});

describe('nameTokens', () => {
  it('drops stopwords and brand tokens and singularizes', () => {
    expect(nameTokens('PanOxyl 10% Foam Acne Foaming Wash', 'PanOxyl')).toEqual(
      new Set(['10', 'foam', 'acne', 'foaming', 'wash']),
    );
    expect(nameTokens('Classic Macaroni and Cheese', "Annie's Homegrown")).toEqual(
      new Set(['classic', 'macaroni', 'cheese']),
    );
  });

  it('makes word order irrelevant', () => {
    expect(nameTokens('Apple Envy')).toEqual(nameTokens('Envy Apple'));
  });
});

describe('brandKey', () => {
  it('normalizes case, punctuation, and known aliases', () => {
    expect(brandKey("Annie's Homegrown")).toBe('annies');
    expect(brandKey("Annie's")).toBe('annies');
    expect(brandKey('365 by Whole Foods Market')).toBe('365');
    expect(brandKey('Kirkland Signature')).toBe('kirkland');
    expect(brandKey('CLIF')).toBe('clif');
    expect(brandKey('Clif Bar')).toBe('clif');
    expect(brandKey('')).toBe('');
  });
});

describe('diceSimilarity', () => {
  it('scores real pairs from the export sensibly', () => {
    const stok = diceSimilarity(nameTokens('Cold Brew Coffee', 'Stok'), nameTokens('Unsweetened Cold Brew Coffee', 'Stok'));
    expect(stok).toBeGreaterThan(0.8);

    const panoxyl = diceSimilarity(
      nameTokens('Acne Foaming Wash', 'PanOxyl'),
      nameTokens('PanOxyl 10% Foam Acne Foaming Wash', 'PanOxyl'),
    );
    expect(panoxyl).toBeGreaterThan(0.7);

    const apples = diceSimilarity(nameTokens('Apple'), nameTokens('Envy Apple'));
    expect(apples).toBeGreaterThan(0.6);
    expect(apples).toBeLessThan(0.8);

    const oreo = diceSimilarity(
      nameTokens('Oreo BTS Brown Sugar Pancake Flavor Cream Sandwich Cookies', 'Oreo'),
      nameTokens('Oreo Double Stuf Chocolate Sandwich Cookies', 'Oreo'),
    );
    expect(oreo).toBeLessThan(0.6);
  });

  it('keeps the search tokenizer behavior', () => {
    expect(tokenize("Driscoll's Blueberries")).toEqual(new Set(['driscolls', 'blueberries']));
  });
});
