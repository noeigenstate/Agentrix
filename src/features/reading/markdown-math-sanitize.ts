import type { DOMPurify } from 'dompurify';

export const mathSourceAttribute = 'data-reading-math-source';
export const mathSelector = 'span[' + mathSourceAttribute + ']';

const mathML = 'math semantics annotation mrow mi mn mo mtext mspace mfrac msqrt mroot msub msup msubsup mover munder munderover mmultiscripts mprescripts'
  + ' none mtable mtr mtd mstyle mpadded mphantom menclose mglyph';
const mathMLTags = new Set(mathML.split(' '));
const svgTags = new Set(['svg', 'path', 'line']);
const mathMLAttrs = 'xmlns display encoding mathvariant mathsize mathcolor mathbackground stretchy symmetric fence separator lspace rspace'
  + ' accent accentunder linethickness width height depth voffset rowspacing columnspacing rowlines columnlines columnalign rowalign'
  + ' columnspan rowspan columnwidth displaystyle scriptlevel notation minsize maxsize form movablelimits largeop';
const mathLayoutAttributes = new Set(mathMLAttrs.split(' '));
const svgAttrs = new Set('xmlns width height viewbox preserveaspectratio d x1 y1 x2 y2 stroke-width'.split(' '));
const spanAttrs = new Set(['style', 'aria-hidden', mathSourceAttribute]);
const mathAttributes = [...new Set([...mathLayoutAttributes, ...svgAttrs, ...spanAttrs])];

const styleProperties = new Set(('height width min-width top bottom left vertical-align margin margin-top margin-right margin-left padding-left position color background-color '
  + 'border-top-width border-bottom-width border-right-width border-right-style border-width border-style border-color text-shadow').split(' '));
const safeStyle = (style: string) => style.split(';').every(declaration => {
  if (!declaration.trim()) return true;
  const [property, value, extra] = declaration.split(':');
  const name = property.trim();
  return extra === undefined && styleProperties.has(name) && /^[\s#.\w%+-]+$/.test(value ?? '')
    && (name !== 'position' || /^(?:absolute|relative)$/.test(value.trim()));
});

export function allowReadingMath(purifier: DOMPurify) {
  purifier.addHook('uponSanitizeElement', (node, { tagName, allowedTags }) => {
    if (tagName === 'span' || mathMLTags.has(tagName) || svgTags.has(tagName)) {
      allowedTags[tagName] = (node as Element).closest(mathSelector) !== null;
    }
  });
  purifier.addHook('uponSanitizeAttribute', (node, event) => {
    const { attrName, attrValue } = event;
    if (!mathAttributes.includes(attrName)) return;
    const tag = node.localName;
    const permitted = tag === 'span' ? spanAttrs : mathMLTags.has(tag) ? mathLayoutAttributes : svgTags.has(tag) ? svgAttrs : null;
    event.keepAttr = !!node.closest(mathSelector) && !!permitted?.has(attrName)
      && (attrName !== 'style' || safeStyle(attrValue));
  });
}

export const readingMathAttributes = mathAttributes;
