// =========================================================================
// Product Customizer — standalone app (runs inside the Wix iframe/HTML
// embed). Talks to the Wix Velo parent page via window.postMessage.
//
// Message contract (see README.md for full details):
//   Parent -> iframe: { type: 'INIT', payload: {...productConfig} }
//   Parent -> iframe: { type: 'ADD_TO_CART_SUCCESS' }
//   Parent -> iframe: { type: 'ADD_TO_CART_ERROR', payload: { message } }
//   iframe -> Parent: { type: 'CUSTOMIZER_READY' }
//   iframe -> Parent: { type: 'ADD_TO_CART', payload: { recipientName, title, size } }
// =========================================================================

const state = {
  config: null,
  currentSizeKey: null,
  designs: [], // { id, el, src }
};

const els = {
  previewStage: document.getElementById('previewStage'),
  productImage: document.getElementById('productImage'),
  previewText: document.getElementById('previewText'),
  previewTitleText: document.getElementById('previewTitleText'),
  productName: document.getElementById('productName'),
  productPrice: document.getElementById('productPrice'),
  recipientLabel: document.getElementById('recipientLabel'),
  titleLabel: document.getElementById('titleLabel'),
  recipientInput: document.getElementById('recipientInput'),
  titleInput: document.getElementById('titleInput'),
  sizeSelect: document.getElementById('sizeSelect'),
  baseDesignLabel: document.getElementById('baseDesignLabel'),
  baseDesignSelect: document.getElementById('baseDesignSelect'),
  designUpload: document.getElementById('designUpload'),
  addToCartButton: document.getElementById('addToCartButton'),
  statusMessage: document.getElementById('statusMessage'),
};

// =========================================================================
// FALLBACK DESIGNS — used only if the parent page couldn't find any rows
// in the ProductDesigns collection for this product (e.g. not set up
// yet). In normal operation, the design list comes from INIT's
// `baseDesigns`, sourced from that database — see product_customizer_parent.js.
// =========================================================================
const FALLBACK_DESIGNS = [
  {
    id: 'classic-cup',
    label: 'Classic Cup',
    image:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 240"><rect x="70" y="200" width="60" height="16" rx="2" fill="#8a6d1f"/><rect x="85" y="170" width="30" height="34" fill="#d4af37"/><path d="M60 40h80v40c0 30-18 55-40 60-22-5-40-30-40-60V40z" fill="#d4af37"/><path d="M60 55c-20-4-32 8-30 24 2 14 16 22 32 20" stroke="#b8952a" stroke-width="6" fill="none"/><path d="M140 55c20-4 32 8 30 24-2 14-16 22-32 20" stroke="#b8952a" stroke-width="6" fill="none"/></svg>`
      ),
  },
  {
    id: 'star-cup',
    label: 'Star Cup',
    image:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 240"><rect x="70" y="200" width="60" height="16" rx="2" fill="#5c5c5c"/><rect x="85" y="170" width="30" height="34" fill="#c0c0c0"/><path d="M60 40h80v40c0 30-18 55-40 60-22-5-40-30-40-60V40z" fill="#c0c0c0"/><polygon points="100,55 108,72 126,72 111,83 117,101 100,90 83,101 89,83 74,72 92,72" fill="#b8232f"/></svg>`
      ),
  },
  {
    id: 'shield',
    label: 'Shield',
    image:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 240"><rect x="80" y="190" width="40" height="30" fill="#4a4a4a"/><path d="M40 30h120v70c0 55-40 90-60 100-20-10-60-45-60-100V30z" fill="#3f6fb0"/><path d="M40 30h120v20H40z" fill="#2e5690"/></svg>`
      ),
  },
];

// --- text fitting -------------------------------------------------------

function measureTextWidth(text, fontSize, fontFamily = 'Georgia, serif') {
  measureTextWidth._canvas = measureTextWidth._canvas || document.createElement('canvas');
  const ctx = measureTextWidth._canvas.getContext('2d');
  ctx.font = `${fontSize}px ${fontFamily}`;
  return ctx.measureText(text).width;
}

function fitText(el, text, maxWidth, baseFontSize) {
  el.textContent = text;
  let fontSize = baseFontSize;
  while (text && measureTextWidth(text, fontSize) > maxWidth && fontSize > 10) {
    fontSize -= 1;
  }
  el.style.fontSize = `${fontSize}px`;
}

// --- dragging -------------------------------------------------------------

// Makes any absolutely-positioned element draggable within `container`,
// using Pointer Events so mouse, touch, and pen all work the same way.
// Move/up listeners are attached to `document` (not the element itself)
// so dragging keeps working even if the browser won't grant pointer
// capture on a given element type (some browsers restrict this for
// <img> elements, even though it's fine on a <div>).
function makeDraggable(el, container) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();

    try {
      el.setPointerCapture(e.pointerId);
    } catch (err) {
      // Not supported for this element in this browser — that's fine,
      // the document-level listeners below still handle the drag.
    }

    el.classList.add('dragging');

    const startX = e.clientX;
    const startY = e.clientY;
    const elRect = el.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const origLeft = elRect.left - containerRect.left;
    const origTop = elRect.top - containerRect.top;

    function onMove(moveEvent) {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      const maxLeft = containerRect.width - elRect.width;
      const maxTop = containerRect.height - elRect.height;

      const newLeft = Math.max(0, Math.min(maxLeft, origLeft + dx));
      const newTop = Math.max(0, Math.min(maxTop, origTop + dy));

      el.style.left = `${newLeft}px`;
      el.style.top = `${newTop}px`;
    }

    function onUp(upEvent) {
      try {
        el.releasePointerCapture(upEvent.pointerId);
      } catch (err) {
        // ignore — see note above
      }
      el.classList.remove('dragging');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

// Centers an element inside the stage the first time it gets content,
// anchored around a given vertical fraction (0 = top, 1 = bottom) so
// the recipient name and title land in sensible starting spots without
// needing a CSS transform (which would fight with left/top dragging).
function centerElement(el, container, verticalFraction) {
  const left = (container.clientWidth - el.offsetWidth) / 2;
  const top = container.clientHeight * verticalFraction - el.offsetHeight / 2;
  el.style.left = `${Math.max(0, left)}px`;
  el.style.top = `${Math.max(0, top)}px`;
}

// --- trophy design (base image) selection ------------------------------

// Works out which image should currently be shown as the base product
// photo. Priority: an image the chosen trophy design defines specifically
// for the chosen size > an image the size config defines (legacy behavior)
// > the trophy design's own default image > the original product photo.
function updateProductImage() {
  const design = (state.baseDesigns || []).find((d) => d.id === state.currentDesignId);
  const sizeConfig = state.currentSizeKey ? (state.config.sizeScaleMap || {})[state.currentSizeKey] : null;

  const sizeSpecificDesignImage =
    design && design.sizeImages && design.sizeImages[state.currentSizeKey];

  els.productImage.src =
    sizeSpecificDesignImage ||
    (sizeConfig && sizeConfig.image) ||
    (design && design.image) ||
    state.config.productImage ||
    '';
}

function applyBaseDesign(id) {
  const design = (state.baseDesigns || []).find((d) => d.id === id);
  if (!design) return;

  state.currentDesignId = id;
  state.currentDesignLabel = design.label;

  updateProductImage();
}

function setupBaseDesignSelect() {
  const designs =
    state.config.baseDesigns && state.config.baseDesigns.length
      ? state.config.baseDesigns
      : FALLBACK_DESIGNS;

  state.baseDesigns = designs;

  els.baseDesignLabel.textContent = state.config.designSelectLabel || 'Design';

  els.baseDesignSelect.innerHTML = designs
    .map((d) => `<option value="${d.id}">${d.label}</option>`)
    .join('');

  els.baseDesignSelect.onchange = () => applyBaseDesign(els.baseDesignSelect.value);

  if (designs.length) {
    els.baseDesignSelect.value = designs[0].id;
    applyBaseDesign(designs[0].id);
  }
}

// --- designs ----------------------------------------------------------

function addDesign(src) {
  const img = document.createElement('img');
  img.src = src;
  img.className = 'design-item draggable';
  img.draggable = false; // disable native browser drag-out so pointer drag works
  img.addEventListener('dragstart', (e) => e.preventDefault()); // belt-and-suspenders for Safari
  els.previewStage.appendChild(img);

  // Start it centered-ish; the customer drags it wherever they want
  img.style.left = `${els.previewStage.clientWidth / 2 - 30}px`;
  img.style.top = `${els.previewStage.clientHeight / 2 - 30}px`;

  img.addEventListener('dblclick', () => {
    img.remove();
    state.designs = state.designs.filter((d) => d.el !== img);
  });

  makeDraggable(img, els.previewStage);
  state.designs.push({ id: `${Date.now()}`, el: img, src });
}

els.designUpload.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => addDesign(reader.result);
  reader.readAsDataURL(file);
  e.target.value = ''; // allow uploading the same file again later
});

// --- config / rendering ---------------------------------------------------

function applyStyles() {
  const { previewFontSize = 24, previewFontColor = '#1a1a1a' } = state.config;
  els.previewText.style.color = previewFontColor;
  els.previewTitleText.style.color = previewFontColor;
  els.previewText.style.fontSize = `${previewFontSize}px`;
  els.previewTitleText.style.fontSize = `${Math.round(previewFontSize * 0.7)}px`;
}

function applySize(sizeKey) {
  const sizeConfig = (state.config.sizeScaleMap || {})[sizeKey];
  if (!sizeConfig) return;
  state.currentSizeKey = sizeKey;
  updateProductImage();
  document.querySelector('.preview-stage').style.transform = sizeConfig.scale
    ? `scale(${sizeConfig.scale})`
    : 'scale(1)';
}

function setupSizeSelect() {
  const sizeKeys = Object.keys(state.config.sizeScaleMap || {});
  const sizeRow = els.sizeSelect.closest('div') || els.sizeSelect;
  const sizeLabel = document.querySelector('label[for="sizeSelect"]');

  if (sizeKeys.length === 0) {
    if (sizeLabel) sizeLabel.style.display = 'none';
    els.sizeSelect.style.display = 'none';
    return;
  }

  if (sizeLabel) sizeLabel.style.display = '';
  els.sizeSelect.style.display = '';
  els.sizeSelect.innerHTML = sizeKeys.map((k) => `<option value="${k}">${k}</option>`).join('');
  applySize(sizeKeys[0]);
  els.sizeSelect.value = sizeKeys[0];
  els.sizeSelect.onchange = () => applySize(els.sizeSelect.value);
}

function initFromConfig(payload) {
  state.config = payload;

  els.productImage.src = payload.productImage || '';
  els.productName.textContent = payload.productName || '';
  els.productPrice.textContent = payload.price ? `\u20b1${payload.price}` : '';

  els.recipientLabel.textContent = payload.recipientLabel || 'Recipient Name';
  els.titleLabel.textContent = payload.titleLabel || 'Title';
  els.recipientInput.maxLength = payload.maxNameLength || 40;
  els.titleInput.maxLength = payload.maxTitleLength || 40;

  els.previewText.textContent = '';
  els.previewTitleText.textContent = '';
  els.recipientInput.value = '';
  els.titleInput.value = '';
  els.statusMessage.textContent = '';
  els.addToCartButton.disabled = false;

  // Clear any designs left over from a previous product
  state.designs.forEach((d) => d.el.remove());
  state.designs = [];

  applyStyles();
  setupBaseDesignSelect();
  setupSizeSelect();

  // Give the text elements a sensible starting position, then let the
  // customer drag them anywhere from there.
  centerElement(els.previewText, els.previewStage, 0.55);
  centerElement(els.previewTitleText, els.previewStage, 0.68);
  makeDraggable(els.previewText, els.previewStage);
  makeDraggable(els.previewTitleText, els.previewStage);
}

// --- input handlers ---------------------------------------------------

els.recipientInput.addEventListener('input', () => {
  if (!state.config) return;
  const maxWidth = state.config.previewMaxWidth || 200;
  const baseFontSize = state.config.previewFontSize || 24;
  fitText(els.previewText, els.recipientInput.value, maxWidth, baseFontSize);
});

els.titleInput.addEventListener('input', () => {
  if (!state.config) return;
  const maxWidth = state.config.previewMaxWidth || 200;
  const baseFontSize = (state.config.previewFontSize || 24) * 0.7;
  fitText(els.previewTitleText, els.titleInput.value, maxWidth, baseFontSize);
});

els.addToCartButton.addEventListener('click', () => {
  if (!state.config) return;
  const recipientName = els.recipientInput.value.trim();
  const title = els.titleInput.value.trim();

  if (state.config.requireRecipientName && !recipientName) {
    els.statusMessage.textContent = 'Please enter a recipient name.';
    return;
  }

  els.addToCartButton.disabled = true;
  els.statusMessage.textContent = 'Adding to cart\u2026';

  // Capture final placement so production/fulfillment knows exactly
  // where the text and any designs ended up on the plaque.
  const stageRect = els.previewStage.getBoundingClientRect();
  const relativePosition = (el) => {
    const r = el.getBoundingClientRect();
    return {
      xPct: ((r.left - stageRect.left) / stageRect.width) * 100,
      yPct: ((r.top - stageRect.top) / stageRect.height) * 100,
    };
  };

  window.parent.postMessage(
    {
      type: 'ADD_TO_CART',
      payload: {
        recipientName,
        title,
        size: state.currentSizeKey,
        baseDesign: state.currentDesignId
          ? { id: state.currentDesignId, label: state.currentDesignLabel }
          : null,
        recipientPosition: relativePosition(els.previewText),
        titlePosition: relativePosition(els.previewTitleText),
        designs: state.designs.map((d) => ({
          src: d.src,
          ...relativePosition(d.el),
        })),
      },
    },
    '*' // TODO: replace '*' with your actual Wix site origin before going live
  );
});

// --- messages from the parent (Wix Velo page) ---------------------------

window.addEventListener('message', (event) => {
  const { type, payload } = event.data || {};

  if (type === 'INIT') {
    initFromConfig(payload);
  }

  if (type === 'ADD_TO_CART_SUCCESS') {
    els.addToCartButton.disabled = false;
    els.statusMessage.textContent = 'Added to cart!';
  }

  if (type === 'ADD_TO_CART_ERROR') {
    els.addToCartButton.disabled = false;
    els.statusMessage.textContent = `Something went wrong: ${(payload && payload.message) || 'please try again'}`;
  }
});

// Tell the parent we're loaded and ready to receive product config
window.parent.postMessage({ type: 'CUSTOMIZER_READY' }, '*');