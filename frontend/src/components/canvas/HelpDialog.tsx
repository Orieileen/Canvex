import {
  HelpCircle,
  SquareDashed,
  Wand2,
  Sparkles,
  Rocket,
  Lightbulb,
} from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface HelpSection {
  icon: typeof HelpCircle;
  title: string;
  blurb: string;
  steps: string[];
  list?: { heading: string; items: string[] };
  tips?: string[];
}

export function HelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("canvasUi");

  // Tutorial content. The icon + which sections have a list live here; the text
  // (title/blurb/steps/tips/items) is pulled whole from the i18n arrays via
  // returnObjects, so adding/removing a step only touches help.ts.
  const SECTIONS: HelpSection[] = useMemo(() => {
    // returnObjects yields the array; if a key is missing/renamed i18next returns
    // the key string, so guard with Array.isArray to fail soft (empty) not crash.
    const arr = (key: string): string[] => {
      const v = t(key, { returnObjects: true });
      return Array.isArray(v) ? (v as string[]) : [];
    };
    const defs: { icon: typeof HelpCircle; key: string; hasList?: boolean; hasTips?: boolean }[] = [
      { icon: SquareDashed, key: "annotate", hasTips: true },
      { icon: Wand2, key: "toolbar", hasList: true, hasTips: true },
      { icon: Sparkles, key: "skills", hasList: true, hasTips: true },
      { icon: Rocket, key: "gettingStarted" },
    ];
    return defs.map(({ icon, key, hasList, hasTips }) => ({
      icon,
      title: t(`help.${key}.title`),
      blurb: t(`help.${key}.blurb`),
      steps: arr(`help.${key}.steps`),
      list: hasList
        ? { heading: t(`help.${key}.list.heading`), items: arr(`help.${key}.list.items`) }
        : undefined,
      tips: hasTips ? arr(`help.${key}.tips`) : undefined,
    }));
  }, [t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HelpCircle className="size-5 text-primary" />
            {t("help.dialogTitle")}
          </DialogTitle>
          <DialogDescription>{t("help.dialogDescription")}</DialogDescription>
        </DialogHeader>

        <div className="-mr-2 flex max-h-[70vh] flex-col gap-7 overflow-y-auto pr-2 pt-1">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <section.icon className="size-4 shrink-0 text-primary" />
                {section.title}
              </h3>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                {section.blurb}
              </p>
              <ol className="mt-2.5 flex list-decimal flex-col gap-1.5 pl-5 text-[13px] leading-relaxed marker:text-muted-foreground">
                {section.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
              {section.list && (
                <div className="mt-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {section.list.heading}
                  </p>
                  <ul className="mt-1.5 flex flex-col gap-1.5 text-[13px] leading-relaxed">
                    {section.list.items.map((item, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="mt-[7px] size-1 shrink-0 rounded-full bg-primary" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {section.tips?.map((tip, i) => (
                <p
                  key={i}
                  className="mt-2 flex gap-2 rounded-md bg-muted px-2.5 py-1.5 text-[12px] leading-relaxed text-muted-foreground"
                >
                  <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-primary" />
                  <span>{tip}</span>
                </p>
              ))}
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
