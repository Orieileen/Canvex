// #spapi_first: This component now consumes a simple array of field definitions from our own backend.

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// Interfaces matching our backend's SchemaField and FieldChoice models
interface FieldChoice {
  value: string;
  label: string;
}

interface SchemaField {
  name: string;
  label: string;
  field_type: 'TEXT' | 'NUMBER' | 'BOOLEAN' | 'SELECT';
  is_required: boolean;
  help_text?: string;
  choices: FieldChoice[];
  group_name?: string;
  order?: number;
}

interface DynamicSchemaFormProps {
  fields: SchemaField[];
  onSubmit: (formData: Record<string, any>) => void;
  onCancel: () => void;
  initialValues?: Record<string, any>;
  helpTextWhitelist?: string[];
}

export function DynamicSchemaForm({ fields, onSubmit, onCancel, initialValues, helpTextWhitelist }: DynamicSchemaFormProps) {
  const [formData, setFormData] = useState<Record<string, any>>(initialValues || {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { t } = useTranslation(['form','common','schema']);

  // Normalize backend field aliases to canonical keys for i18n lookup
  // This avoids duplicating translations for semantically identical fields
  const FIELD_ALIAS: Record<string, string> = {
    // Add field aliases here if needed in the future

  };
  const helpWhitelist = useMemo(() => (helpTextWhitelist ? new Set(helpTextWhitelist) : null), [helpTextWhitelist]);

  const handleInputChange = (fieldName: string, value: any) => {
    setFormData(prev => ({ ...prev, [fieldName]: value }));
  };

  const validate = () => {
    const next: Record<string, string> = {};
    const gtinExempt = !!formData['supplier_declared_has_product_identifier_exemption'];
    for (const f of fields) {
      // dynamic required: GTIN depends on exemption
      let required = f.is_required;
      if (f.name === 'externally_assigned_product_identifier' || f.name === 'gtin_type') {
        required = !gtinExempt; // require only when not exempt
      }
      if (!required) continue;
      const v = formData[f.name];
      const missing = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
      if (missing) next[f.name] = t('form:required');
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    const payload: Record<string, any> = { ...formData };
    fields.forEach((field) => {
      if (field.field_type !== 'NUMBER') return;
      const raw = payload[field.name];
      if (raw === '' || raw === undefined || raw === null) {
        delete payload[field.name];
        return;
      }
      if (typeof raw === 'string') {
        const parsed = Number(raw);
        if (!Number.isNaN(parsed)) {
          payload[field.name] = parsed;
        }
      }
    });
    onSubmit(payload);
  };

  const numberChange = (name: string, raw: string) => {
    if (raw === '') {
      setFormData(prev => ({ ...prev, [name]: '' }));
      return;
    }
    const decimalPattern = /^-?\d*(\.\d*)?$/;
    if (decimalPattern.test(raw)) {
      setFormData(prev => ({ ...prev, [name]: raw }));
    }
  };

  const renderFormField = (field: SchemaField) => {
    const { name, label, field_type, is_required, help_text, choices } = field;
    const i18nName = FIELD_ALIAS[name] || name;
    const displayLabel = t(`schema:labels.${i18nName}`, { defaultValue: label });
    const allowHelp = !helpWhitelist || helpWhitelist.has(name);
    const displayHelp = allowHelp ? (t(`schema:help.${i18nName}`, { defaultValue: help_text || '' }) as string) : '';
    const error = errors[name];
    const gtinExempt = !!formData['supplier_declared_has_product_identifier_exemption'];
    const computedRequired = (() => {
      if (name === 'externally_assigned_product_identifier' || name === 'gtin_type') return !gtinExempt;
      return is_required;
    })();

    switch (field_type) {
      case 'SELECT':
        return (
          <div key={name} className="space-y-2">
            <Label htmlFor={name}>
              {displayLabel}
              {computedRequired && <span className="text-red-500 ml-1">*</span>}
            </Label>
            <Select onValueChange={(value) => handleInputChange(name, value)} value={formData[name]} disabled={(name === 'gtin_type' || name === 'externally_assigned_product_identifier') && gtinExempt}>
              <SelectTrigger id={name} className={error ? 'border-red-500 focus-visible:ring-red-500' : undefined}>
                <SelectValue placeholder={t('form:selectPlaceholder', { label: displayLabel })} />
              </SelectTrigger>
              <SelectContent>
                {choices.map((choice) => {
                  const cLabel = t(`schema:choices.${i18nName}.${choice.value}`, { defaultValue: choice.label });
                  return <SelectItem key={choice.value} value={choice.value}>{cLabel}</SelectItem>
                })}
              </SelectContent>
            </Select>
            {error && <p className="text-xs text-red-600">{error}</p>}
            {allowHelp && displayHelp && <p className="text-xs text-muted-foreground">{displayHelp}</p>}
            {(name === 'gtin_type' || name === 'externally_assigned_product_identifier') && gtinExempt && (
              <p className="text-xs text-muted-foreground">{t('form:gtinExemptHint')}</p>
            )}
          </div>
        );
      case 'TEXT':
        return (
          <div key={name} className="space-y-2">
            <Label htmlFor={name}>
              {displayLabel}
              {computedRequired && <span className="text-red-500 ml-1">*</span>}
            </Label>
            <Input
              id={name}
              className={error ? 'border-red-500 focus-visible:ring-red-500' : undefined}
              value={formData[name] ?? ''}
              onChange={(e) => handleInputChange(name, e.target.value)}
              disabled={(name === 'externally_assigned_product_identifier') && gtinExempt}
            />
            {error && <p className="text-xs text-red-600">{error}</p>}
            {allowHelp && displayHelp && <p className="text-xs text-muted-foreground">{displayHelp}</p>}
            {name === 'externally_assigned_product_identifier' && gtinExempt && (
              <p className="text-xs text-muted-foreground">{t('form:gtinExemptHint')}</p>
            )}
          </div>
        );
      case 'BOOLEAN':
        return (
          <div key={name} className="flex items-center space-x-2 pt-2">
            <Switch
              id={name}
              checked={!!formData[name]}
              onCheckedChange={(checked) => handleInputChange(name, checked)}
            />
            <Label htmlFor={name}>
              {displayLabel}
              {is_required && <span className="text-red-500 ml-1">*</span>}
            </Label>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>
        );
      case 'NUMBER':
        return (
          <div key={name} className="space-y-2">
            <Label htmlFor={name}>
              {displayLabel}
              {is_required && <span className="text-red-500 ml-1">*</span>}
            </Label>
            <Input
              id={name}
              type="text"
              inputMode="decimal"
              className={error ? 'border-red-500 focus-visible:ring-red-500' : undefined}
              value={formData[name] ?? ''}
              onChange={(e) => numberChange(name, e.target.value)}
            />
            {error && <p className="text-xs text-red-600">{error}</p>}
            {allowHelp && displayHelp && <p className="text-xs text-muted-foreground">{displayHelp}</p>}
          </div>
        );
      default:
        return null;
    }
  };

  // Parse variation fields for summary table
  const variationSummary = useMemo(() => {
    const sizesText = (formData['sizes_text'] ?? '').toString().trim()
    const priceMapText = (formData['per_size_price'] ?? '').toString().trim()
    const qtyMapText = (formData['per_size_qty'] ?? '').toString().trim()
    const weightMapText = (formData['per_size_weight'] ?? '').toString().trim()

    if (!sizesText) return null

    const parseSizes = (txt: string): string[] => {
      if (!txt) return []
      return txt
        .split(';')
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => s.replace(/\s+/g, '').replace(/in$/i, '').toLowerCase().replace('×', 'x'))
    }

    const parseMap = (txt: string): Record<string, string> => {
      if (!txt) return {}
      const m: Record<string, string> = {}
      txt.split(';').map(seg => seg.trim()).filter(Boolean).forEach(seg => {
        const idx = seg.indexOf(':')
        if (idx === -1) return
        const k = seg.slice(0, idx).trim().toLowerCase().replace(/\s+/g, '').replace('×', 'x')
        const v = seg.slice(idx + 1).trim()
        if (k && v) m[k] = v
      })
      return m
    }

    const sizes = parseSizes(sizesText)
    if (sizes.length === 0) return null

    const priceMap = parseMap(priceMapText)
    const qtyMap = parseMap(qtyMapText)
    const weightMap = parseMap(weightMapText)

    return sizes.map(size => ({
      size,
      price: priceMap[size] || '-',
      qty: qtyMap[size] || '-',
      weight: weightMap[size] || '-',
    }))
  }, [formData])

  const renderVariationTable = () => {
    if (!variationSummary || variationSummary.length === 0) return null

    return (
      <div className="mt-4 p-3 border rounded-md bg-muted/30">
        <div className="text-sm font-semibold mb-2">{t('schema:variationSummary', { defaultValue: 'Variation Summary' })}</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="text-left py-1 px-2">{t('schema:labels.size', { defaultValue: 'Size' })}</th>
              <th className="text-left py-1 px-2">{t('schema:labels.price', { defaultValue: 'Price' })}</th>
              <th className="text-left py-1 px-2">{t('schema:labels.qty', { defaultValue: 'Qty' })}</th>
              <th className="text-left py-1 px-2">{t('schema:labels.weight', { defaultValue: 'Weight' })}</th>
            </tr>
          </thead>
          <tbody>
            {variationSummary.map((row, idx) => (
              <tr key={idx} className="border-b last:border-b-0">
                <td className="py-1 px-2 font-mono">{row.size}</td>
                <td className="py-1 px-2">{row.price}</td>
                <td className="py-1 px-2">{row.qty}</td>
                <td className="py-1 px-2">{row.weight}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const grouped = useMemo(() => {
    const g: Record<string, { raw: string; key: string; items: SchemaField[] }> = {} as any;
    for (const f of fields) {
      const raw = f.group_name || 'General';
      const key = t(`schema:groups.${raw}`, { defaultValue: raw });
      const k = `${raw}__${key}`; // preserve stable bucket but show translated label
      if (!g[k]) g[k] = { raw, key, items: [] } as any;
      g[k].items.push(f);
    }
    Object.values(g).forEach(obj => obj.items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
    return g;
  }, [fields, t]);

  // Dev-time diagnostics: log fields whose labels/help/choices still show untranslated Chinese
  if (import.meta && (import.meta as any).env?.DEV) {
    try {
      const hasCJK = (s?: string) => !!s && /[\u3400-\u9FFF]/.test(s);
      const missing: string[] = [];
      for (const f of fields) {
        const i18nName = FIELD_ALIAS[f.name] || f.name;
        const lbl = t(`schema:labels.${i18nName}`, { defaultValue: f.label });
        const hlp = t(`schema:help.${i18nName}`, { defaultValue: f.help_text || '' }) as string;
        if (hasCJK(lbl as string)) missing.push(`label:${f.name}`);
        if (hasCJK(hlp)) missing.push(`help:${f.name}`);
        if (Array.isArray(f.choices)) {
          for (const c of f.choices) {
            const cl = t(`schema:choices.${i18nName}.${c.value}`, { defaultValue: c.label });
            if (hasCJK(cl as string)) missing.push(`choice:${f.name}.${c.value}`);
          }
        }
      }
      if (missing.length) {
         
        console.warn('[i18n] Untranslated schema keys (add to schema.labels/help/choices):', missing);
      }
    } catch {}
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col max-h-[70vh]">
      {/* Scrollable content with extra bottom padding so last field never sits under footer */}
      <div className="flex-1 overflow-y-auto p-1 pr-4 space-y-6 pb-28">
        {Object.entries(grouped).map(([bucket, obj]) => (
          <div key={bucket} className="space-y-4">
            <div className="text-sm font-semibold text-muted-foreground">{(obj as any).key}</div>
            <div className="space-y-4">
              {(obj as any).items.map(renderFormField)}
            </div>
            {/* Show variation summary table after Variation group */}
            {((obj as any).raw === 'Variation' || (obj as any).raw === '变体') && renderVariationTable()}
          </div>
        ))}
      <div className="sticky bottom-0 z-20 bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/60 dark:bg-neutral-900/80 flex justify-end items-center gap-2 border-t px-3 h-16 shrink-0">
        <Button type="button" variant="outline" onClick={onCancel}>{t('common:cancel')}</Button>
        <Button type="submit">{t('form:saveTemplate')}</Button>
      </div>
      </div>
      {/* Sticky footer pinned to form bottom; opaque background; fixed height */}

    </form>
  );
}
