// =========================================================================
// Product Customizer — standalone app (runs inside the Wix iframe/HTML
// embed). Talks to the Wix Velo parent page via window.postMessage.
//
// This version is catalog-driven: the customer picks a Product Type
// (category) and a Design Series (an actual, separate Wix Stores product
// with its own price) before personalizing. It no longer depends on being
// embedded on any specific product's page — the parent sends the WHOLE
// customizable catalog at once.
//
// Message contract:
//   Parent -> iframe: { type: 'INIT', payload: { catalog: [...] } }
//   Parent -> iframe: { type: 'ADD_TO_CART_SUCCESS' }
//   Parent -> iframe: { type: 'ADD_TO_CART_ERROR', payload: { message } }
//   iframe -> Parent: { type: 'CUSTOMIZER_READY' }
//   iframe -> Parent: { type: 'ADD_TO_CART', payload: {
//       productId, recipientName, title, size,
//       recipientPosition, titlePosition, designs
//   } }
//
// Each catalog entry (one "design series"):
//   {
//     productId, category, displayName, price, previewImage,
//     recipientLabel, titleLabel, maxNameLength, maxTitleLength,
//     previewFontSize, previewFontColor, previewMaxWidth,
//     requireRecipientName, sizeScaleMap
//   }
// =========================================================================

const state = {
  catalog: [],
  selectedSeries: null,
  currentSizeKey: null,
  currentFontFamily: "Georgia, 'Times New Roman', serif",
  designs: [], // { id, el, src }
};

const els = {
  previewStage: document.getElementById('previewStage'),
  productImage: document.getElementById('productImage'),
  previewText: document.getElementById('previewText'),
  previewTitleText: document.getElementById('previewTitleText'),
  productName: document.getElementById('productName'),
  productPrice: document.getElementById('productPrice'),
  categorySelect: document.getElementById('categorySelect'),
  seriesSelect: document.getElementById('seriesSelect'),
  fontSelect: document.getElementById('fontSelect'),
  fontUpload: document.getElementById('fontUpload'),
  recipientLabel: document.getElementById('recipientLabel'),
  titleLabel: document.getElementById('titleLabel'),
  recipientInput: document.getElementById('recipientInput'),
  titleInput: document.getElementById('titleInput'),
  sizeSelect: document.getElementById('sizeSelect'),
  designUpload: document.getElementById('designUpload'),
  addToCartButton: document.getElementById('addToCartButton'),
  statusMessage: document.getElementById('statusMessage'),
};

// --- text fitting -------------------------------------------------------

function measureTextWidth(text, fontSize, fontFamily) {
  measureTextWidth._canvas = measureTextWidth._canvas || document.createElement('canvas');
  const ctx = measureTextWidth._canvas.getContext('2d');
  ctx.font = `${fontSize}px ${fontFamily}`;
  return ctx.measureText(text).width;
}

function fitText(el, text, maxWidth, baseFontSize, fontFamily) {
  el.textContent = text;
  let fontSize = baseFontSize;
  while (text && measureTextWidth(text, fontSize, fontFamily) > maxWidth && fontSize > 10) {
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

// --- font selection -------------------------------------------------------

// Applies a font-family string to both preview text elements and re-fits
// their current text, since a new font changes how wide the text renders.
function applyFont(fontFamily) {
  state.currentFontFamily = fontFamily;
  els.previewText.style.fontFamily = fontFamily;
  els.previewTitleText.style.fontFamily = fontFamily;

  if (!state.selectedSeries) return;
  const maxWidth = state.selectedSeries.previewMaxWidth || 200;
  const baseFontSize = state.selectedSeries.previewFontSize || 24;
  fitText(els.previewText, els.recipientInput.value, maxWidth, baseFontSize, fontFamily);
  fitText(els.previewTitleText, els.titleInput.value, maxWidth, baseFontSize * 0.7, fontFamily);
}

els.fontSelect.addEventListener('change', () => {
  applyFont(els.fontSelect.value);
});

els.fontUpload.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const buffer = await file.arrayBuffer();
    const fontName = `CustomFont_${Date.now()}`;
    const fontFace = new FontFace(fontName, buffer);
    await fontFace.load();
    document.fonts.add(fontFace);

    // Add it as a real option so it's visible/selectable, then select it
    const option = document.createElement('option');
    option.value = `'${fontName}', sans-serif`;
    option.textContent = file.name.replace(/\.[^.]+$/, '');
    els.fontSelect.appendChild(option);
    els.fontSelect.value = option.value;

    applyFont(option.value);
  } catch (err) {
    console.error('Could not load uploaded font', err);
    els.statusMessage.textContent = "Couldn't load that font file — try a .ttf, .otf, or .woff.";
  } finally {
    e.target.value = ''; // allow re-uploading the same file later
  }
});

// --- designs (draggable clip-art/uploaded stickers) ---------------------

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

// --- product image ---------------------------------------------------

function updateProductImage() {
  const sizeConfig = state.currentSizeKey
    ? (state.selectedSeries.sizeScaleMap || {})[state.currentSizeKey]
    : null;

  els.productImage.src = (sizeConfig && sizeConfig.image) || state.selectedSeries.previewImage || '';
}

// --- size ---------------------------------------------------------------

function applySize(sizeKey) {
  const sizeConfig = (state.selectedSeries.sizeScaleMap || {})[sizeKey];
  if (!sizeConfig) return;
  state.currentSizeKey = sizeKey;
  updateProductImage();
  document.querySelector('.preview-stage').style.transform = sizeConfig.scale
    ? `scale(${sizeConfig.scale})`
    : 'scale(1)';
}

function setupSizeSelect() {
  const sizeKeys = Object.keys(state.selectedSeries.sizeScaleMap || {});
  const sizeLabel = document.querySelector('label[for="sizeSelect"]');

  if (sizeKeys.length === 0) {
    if (sizeLabel) sizeLabel.style.display = 'none';
    els.sizeSelect.style.display = 'none';
    return;
  }

  if (sizeLabel) sizeLabel.style.display = '';
  els.sizeSelect.style.display = '';
  els.sizeSelect.innerHTML = sizeKeys.map((k) => `<option value="${k}">${k}</option>`).join('');
  els.sizeSelect.value = sizeKeys[0];
  applySize(sizeKeys[0]);
  els.sizeSelect.onchange = () => applySize(els.sizeSelect.value);
}

// --- applying a chosen design series ------------------------------------

function applySeries(productId) {
  const series = state.catalog.find((s) => s.productId === productId);
  if (!series) return;

  state.selectedSeries = series;
  state.currentSizeKey = null;

  els.productName.textContent = series.displayName || '';
  els.productPrice.textContent = series.price ? `\u20b1${series.price}` : '';

  els.recipientLabel.textContent = series.recipientLabel || 'Recipient Name';
  els.titleLabel.textContent = series.titleLabel || 'Title';
  els.recipientInput.maxLength = series.maxNameLength || 40;
  els.titleInput.maxLength = series.maxTitleLength || 40;

  els.previewText.textContent = '';
  els.previewTitleText.textContent = '';
  els.recipientInput.value = '';
  els.titleInput.value = '';
  els.statusMessage.textContent = '';
  els.addToCartButton.disabled = false;

  // Clear any designs left over from a previous series
  state.designs.forEach((d) => d.el.remove());
  state.designs = [];

  els.previewText.style.color = series.previewFontColor || '#1a1a1a';
  els.previewTitleText.style.color = series.previewFontColor || '#1a1a1a';
  els.previewText.style.fontSize = `${series.previewFontSize || 24}px`;
  els.previewTitleText.style.fontSize = `${Math.round((series.previewFontSize || 24) * 0.7)}px`;

  // Reset font choice to the default preset for each new series, clearing
  // out any custom-uploaded font options left from a previous series
  Array.from(els.fontSelect.options)
    .filter((opt) => !opt.classList.contains('preset-font-option'))
    .forEach((opt) => opt.remove());
  els.fontSelect.selectedIndex = 0;
  applyFont(els.fontSelect.value);

  setupSizeSelect();
  updateProductImage();

  centerElement(els.previewText, els.previewStage, 0.55);
  centerElement(els.previewTitleText, els.previewStage, 0.68);
  makeDraggable(els.previewText, els.previewStage);
  makeDraggable(els.previewTitleText, els.previewStage);
}

// --- category / design series pickers ------------------------------------

function setupSeriesSelectForCategory(category) {
  const seriesForCategory = state.catalog.filter((s) => s.category === category);

  els.seriesSelect.innerHTML = seriesForCategory
    .map((s) => `<option value="${s.productId}">${s.displayName}</option>`)
    .join('');

  els.seriesSelect.onchange = () => applySeries(els.seriesSelect.value);

  if (seriesForCategory.length) {
    els.seriesSelect.value = seriesForCategory[0].productId;
    applySeries(seriesForCategory[0].productId);
  }
}

function setupCategorySelect() {
  const categories = [...new Set(state.catalog.map((s) => s.category).filter(Boolean))];

  els.categorySelect.innerHTML = categories
    .map((c) => `<option value="${c}">${c}</option>`)
    .join('');

  els.categorySelect.onchange = () => setupSeriesSelectForCategory(els.categorySelect.value);

  if (categories.length) {
    els.categorySelect.value = categories[0];
    setupSeriesSelectForCategory(categories[0]);
  }
}

function initCatalog(payload) {
  state.catalog = payload.catalog || [];

  if (state.catalog.length === 0) {
    els.statusMessage.textContent = 'No customizable products are set up yet.';
    return;
  }

  setupCategorySelect();
}

// --- input handlers ---------------------------------------------------

els.recipientInput.addEventListener('input', () => {
  if (!state.selectedSeries) return;
  const maxWidth = state.selectedSeries.previewMaxWidth || 200;
  const baseFontSize = state.selectedSeries.previewFontSize || 24;
  fitText(els.previewText, els.recipientInput.value, maxWidth, baseFontSize, state.currentFontFamily);
});

els.titleInput.addEventListener('input', () => {
  if (!state.selectedSeries) return;
  const maxWidth = state.selectedSeries.previewMaxWidth || 200;
  const baseFontSize = (state.selectedSeries.previewFontSize || 24) * 0.7;
  fitText(els.previewTitleText, els.titleInput.value, maxWidth, baseFontSize, state.currentFontFamily);
});

els.addToCartButton.addEventListener('click', () => {
  if (!state.selectedSeries) return;
  const recipientName = els.recipientInput.value.trim();
  const title = els.titleInput.value.trim();

  if (state.selectedSeries.requireRecipientName && !recipientName) {
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
        productId: state.selectedSeries.productId,
        recipientName,
        title,
        size: state.currentSizeKey,
        font: els.fontSelect.options[els.fontSelect.selectedIndex]
          ? els.fontSelect.options[els.fontSelect.selectedIndex].textContent
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
    initCatalog(payload);
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

// Tell the parent we're loaded and ready to receive the catalog
window.parent.postMessage({ type: 'CUSTOMIZER_READY' }, '*');