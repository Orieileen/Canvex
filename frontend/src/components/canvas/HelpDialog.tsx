import {
  HelpCircle,
  SquareDashed,
  Wand2,
  Sparkles,
  Rocket,
  Lightbulb,
} from "lucide-react";

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

// Tutorial content. Kept in sync with the actual feature behaviour (see the
// canvas selection / spatial-prompt / ImageEditBar / SkillSelector code).
const SECTIONS: HelpSection[] = [
  {
    icon: SquareDashed,
    title: "Annotate to steer edits (boxes & arrows)",
    blurb:
      "Draw a box, arrow, or text label over an image to tell the AI exactly where to edit. Your marks are turned into coordinates in the prompt — the source image stays clean and the annotations never show up in the result.",
    steps: [
      "Select an image, draw a shape on top of it, then select both together (marquee or shift-click) — the toolbar switches to “image + shapes”.",
      "A box / ellipse marks a region; an arrow marks a single point at its tip; a text label near a shape is the instruction for that spot (e.g. box the logo + type “make this red”).",
      "Click the “TEXT” tile in the toolbar to preview the exact prompt (e.g. “top-right region (x≈60–90%): make this red”).",
      "Press Apply (wand) — the AI gets the clean original plus your region text. Or use Cutout / Split to target the subject you boxed.",
    ],
    tips: [
      "Rough boxes are fine — coordinates are coarse (a 3×3 grid word + a percentage span), so you don’t need pixel-perfect marks.",
      "Drag arrows FROM the label TOWARD the spot: the arrowhead end is what the model reads.",
    ],
  },
  {
    icon: Wand2,
    title: "The AI toolbar",
    blurb:
      "Select any image on the canvas to get a floating toolbar — re-edit, cut out, split, animate, rotate, mock up, color-grade, merge, download, or send to chat, without typing into the chat box.",
    steps: [
      "Select an image — the toolbar appears below it. Pick a tab: Image / Video / Angle / Split / Merge / Mockup (tabs that don’t fit your selection grey out).",
      "On the Image tab, type a change, set aspect ratio · quality (1K / 2K / 4K) · count (×1 / ×2 / ×4), then press Apply.",
    ],
    list: {
      heading: "Modes",
      items: [
        "Image — edit / restyle by prompt. Cutout (scissors) = one-click transparent background.",
        "Split — two stacked results: a transparent subject + a clean subject-removed background (all-or-nothing).",
        "Angle — drag a 3D cube to re-render the shot from a new viewpoint (needs a pinned image).",
        "Video — describe the motion → a clip (needs a pinned image; takes 1–5 min).",
        "Mockup — wrap a design onto the image via depth: set target → drop another image → Depth / Mask / Opacity.",
        "Merge — flatten the image + your marks into one PNG locally (no AI call).",
        "Single images also get Adjust (a Lightroom-style color panel), Send to chat, and Download.",
      ],
    },
    tips: [
      "Click a thumbnail tile on the left of the toolbar to preview exactly what the AI will receive.",
    ],
  },
  {
    icon: Sparkles,
    title: "Skills",
    blurb:
      "The sliders icon in the chat box lets you turn OFF a skill (a canned playbook the assistant follows) for just your next message, so it answers your request literally instead of running a workflow.",
    steps: [
      "Click the sliders icon → “Skills for this message”. Every skill is on by default; the assistant decides which one fits.",
      "Uncheck a skill to skip it for the next message only — your choice resets automatically after you send.",
    ],
    list: {
      heading: "Available skills",
      items: [
        "image-prompt-sop — rewrites a vague request into a high-quality prompt and auto-picks size + count for a single image.",
        "amazon-listing-pack-sop — turns one product photo into a 7-image Amazon set (main, infographic, angle, detail, 2 lifestyle, scale) generated in parallel.",
      ],
    },
    tips: [
      "The dot on the sliders icon means at least one skill is off this turn. The selector only disables skills — it never forces one.",
    ],
  },
  {
    icon: Rocket,
    title: "Getting started",
    blurb:
      "Generate images and videos by describing them in the chat box, organize work into scenes, and reuse past assets from the media library.",
    steps: [
      "Click “New canvas”, give it a name, and a blank scene opens.",
      "Type into the chat box at the bottom to generate. A placeholder reserves the spot, then the result drops in (images take seconds; video 1–5 min). You can ask for up to 4 at once.",
      "Each row under SCENES is its own canvas; edits autosave. Pin a canvas to the top, rename, or delete via the ⋮ menu.",
      "Open “Media library” to browse everything you’ve made (grouped by canvas) and click a thumbnail to drop it into the current canvas.",
    ],
  },
];

export function HelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HelpCircle className="size-5 text-primary" />
            Canvex — Help &amp; tips
          </DialogTitle>
          <DialogDescription>
            A quick tour of the canvas: annotations, the AI toolbar, skills, and the basics.
          </DialogDescription>
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
