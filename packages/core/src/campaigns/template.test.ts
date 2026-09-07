import { describe, expect, it } from 'vitest';
import {
  contactToTemplateVars,
  extractTemplateVariables,
  renderMessage,
  renderTemplateText,
  validateDripSteps,
  validateMessageTemplate,
} from './template';
import type { TemplateContact } from './template';

const contact: TemplateContact = {
  fullName: 'Jane Doe',
  firstName: null,
  lastName: null,
  company: 'Stripe',
  role: 'Engineer',
  email: 'jane@stripe.com',
  headline: 'Building payments',
  location: 'Berlin',
  industry: 'Fintech',
};

describe('extractTemplateVariables', () => {
  it('finds variables, tolerates inner whitespace, and dedupes', () => {
    expect(extractTemplateVariables('Hi {{firstName}} from {{ company }} — {{firstName}}!')).toEqual([
      'firstName',
      'company',
    ]);
    expect(extractTemplateVariables('no variables here')).toEqual([]);
  });
});

describe('validateMessageTemplate', () => {
  it('accepts a valid template and trims it', () => {
    expect(validateMessageTemplate({ subject: '  Hi {{firstName}} ', body: ' Loved your work ' })).toEqual({
      subject: 'Hi {{firstName}}',
      body: 'Loved your work',
    });
  });

  it('rejects missing/empty fields, oversize fields, and non-objects', () => {
    expect(() => validateMessageTemplate({ subject: '', body: 'x' })).toThrowError(
      /template.subject is required/
    );
    expect(() => validateMessageTemplate({ subject: 'x', body: 'y'.repeat(5001) })).toThrowError(
      /template.body must be 5000 characters or fewer/
    );
    expect(() => validateMessageTemplate('nope')).toThrowError(/must be an object/);
    expect(() => validateMessageTemplate({ subject: '', body: 'y' }, 'steps[2]')).toThrowError(
      /steps\[2\].subject is required/
    );
  });

  it('rejects unknown merge variables at save time, listing the available set', () => {
    expect(() =>
      validateMessageTemplate({ subject: 'Hi {{firstNam}}', body: 'x' })
    ).toThrowError(/Unknown merge variable in template.subject: \{\{firstNam\}\}.*\{\{firstName\}\}/s);
    expect(() => validateMessageTemplate({ subject: 'x', body: '{{secret}} {{evil}}' })).toThrowError(
      /Unknown merge variables in template.body: \{\{secret\}\}, \{\{evil\}\}/
    );
  });
});

describe('validateDripSteps', () => {
  it('defaults to no steps and validates each step', () => {
    expect(validateDripSteps(undefined)).toEqual([]);
    expect(validateDripSteps(null)).toEqual([]);
    expect(
      validateDripSteps([{ delayDays: 3, subject: 'Still there?', body: 'Bump {{firstName}}' }])
    ).toEqual([{ delayDays: 3, subject: 'Still there?', body: 'Bump {{firstName}}' }]);
  });

  it('rejects non-arrays, too many steps, bad delays, and bad messages', () => {
    expect(() => validateDripSteps('nope')).toThrowError(/must be an array/);
    expect(() =>
      validateDripSteps(Array.from({ length: 6 }, () => ({ delayDays: 1, subject: 's', body: 'b' })))
    ).toThrowError(/at most 5 drip steps/);
    expect(() => validateDripSteps([{ delayDays: 0, subject: 's', body: 'b' }])).toThrowError(
      /steps\[0\].delayDays must be a whole number/
    );
    expect(() => validateDripSteps([{ delayDays: 1.5, subject: 's', body: 'b' }])).toThrowError(
      /whole number of days/
    );
    expect(() => validateDripSteps([{ delayDays: 400, subject: 's', body: 'b' }])).toThrowError(
      /between 1 and 365/
    );
    expect(() => validateDripSteps([{ delayDays: 1, subject: '{{nope}}', body: 'b' }])).toThrowError(
      /steps\[0\].subject/
    );
  });
});

describe('contactToTemplateVars / rendering', () => {
  it('derives first/last names from the full name when the columns are empty', () => {
    const vars = contactToTemplateVars(contact);
    expect(vars.firstName).toBe('Jane');
    expect(vars.lastName).toBe('Doe');
    expect(vars.fullName).toBe('Jane Doe');
    expect(vars.company).toBe('Stripe');
  });

  it('prefers explicit name columns and renders nulls as empty strings', () => {
    const vars = contactToTemplateVars({ ...contact, firstName: 'Janet', lastName: 'D.' });
    expect(vars.firstName).toBe('Janet');
    const sparse = contactToTemplateVars({ ...contact, fullName: 'Cher', company: null, email: null });
    expect(sparse.firstName).toBe('Cher');
    expect(sparse.lastName).toBe('');
    expect(sparse.company).toBe('');
    expect(renderTemplateText('at {{company}} <{{email}}>', sparse)).toBe('at  <>');
  });

  it('applies personalized overrides only for whitelisted keys', () => {
    const vars = contactToTemplateVars(contact, { company: 'Stripe ( Payments )', evil: 'x' });
    expect(vars.company).toBe('Stripe ( Payments )');
    expect(vars).not.toHaveProperty('evil');
  });

  it('renderMessage personalizes subject and body', () => {
    const rendered = renderMessage(
      { subject: 'Hi {{firstName}}', body: 'Loved your work at {{company}}, {{fullName}}.' },
      contactToTemplateVars(contact)
    );
    expect(rendered).toEqual({
      subject: 'Hi Jane',
      body: 'Loved your work at Stripe, Jane Doe.',
    });
  });
});
