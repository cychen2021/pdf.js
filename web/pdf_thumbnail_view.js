/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { getOutputScale, NullL10n } from "./ui_utils.js";
import { RenderingCancelledException } from "pdfjs-lib";
import { RenderingStates } from "./pdf_rendering_queue.js";

const MAX_NUM_SCALING_STEPS = 3;
const THUMBNAIL_CANVAS_BORDER_WIDTH = 1; // px
const THUMBNAIL_WIDTH = 98; // px

/**
 * @typedef {Object} PDFThumbnailViewOptions
 * @property {HTMLDivElement} container - The viewer element.
 * @property {number} id - The thumbnail's unique ID (normally its number).
 * @property {PageViewport} defaultViewport - The page viewport.
 * @property {Promise<OptionalContentConfig>} [optionalContentConfigPromise] -
 *   A promise that is resolved with an {@link OptionalContentConfig} instance.
 *   The default value is `null`.
 * @property {IPDFLinkService} linkService - The navigation/linking service.
 * @property {PDFRenderingQueue} renderingQueue - The rendering queue object.
 * @property {function} checkSetImageDisabled
 * @property {boolean} [disableCanvasToImageConversion] - Don't convert the
 *   canvas thumbnails to images. This prevents `toDataURL` calls, but
 *   increases the overall memory usage. The default value is `false`.
 * @property {IL10n} l10n - Localization service.
 */

const TempImageFactory = (function TempImageFactoryClosure() {
  let tempCanvasCache = null;

  return {
    getCanvas(width, height) {
      let tempCanvas = tempCanvasCache;
      if (!tempCanvas) {
        tempCanvas = document.createElement("canvas");
        tempCanvasCache = tempCanvas;
      }
      tempCanvas.width = width;
      tempCanvas.height = height;

      // Since this is a temporary canvas, we need to fill it with a white
      // background ourselves. `_getPageDrawContext` uses CSS rules for this.
      if (
        typeof PDFJSDev === "undefined" ||
        PDFJSDev.test("MOZCENTRAL || GENERIC")
      ) {
        tempCanvas.mozOpaque = true;
      }

      const ctx = tempCanvas.getContext("2d", { alpha: false });
      ctx.save();
      ctx.fillStyle = "rgb(255, 255, 255)";
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
      return tempCanvas;
    },

    destroyCanvas() {
      const tempCanvas = tempCanvasCache;
      if (tempCanvas) {
        // Zeroing the width and height causes Firefox to release graphics
        // resources immediately, which can greatly reduce memory consumption.
        tempCanvas.width = 0;
        tempCanvas.height = 0;
      }
      tempCanvasCache = null;
    },
  };
})();

/**
 * @implements {IRenderableView}
 */
class PDFThumbnailView {
  /**
   * @param {PDFThumbnailViewOptions} options
   */
  constructor({
    container,
    id,
    defaultViewport,
    optionalContentConfigPromise,
    linkService,
    renderingQueue,
    checkSetImageDisabled,
    disableCanvasToImageConversion = false,
    l10n = NullL10n,
  }) {
    this.id = id;
    this.renderingId = "thumbnail" + id;
    this.pageLabel = null;

    this.pdfPage = null;
    this.rotation = 0;
    this.viewport = defaultViewport;
    this.pdfPageRotate = defaultViewport.rotation;
    this._optionalContentConfigPromise = optionalContentConfigPromise || null;

    this.linkService = linkService;
    this.renderingQueue = renderingQueue;

    this.renderTask = null;
    this.renderingState = RenderingStates.INITIAL;
    this.resume = null;
    this._checkSetImageDisabled =
      checkSetImageDisabled ||
      function () {
        return false;
      };
    this.disableCanvasToImageConversion = disableCanvasToImageConversion;

    this.pageWidth = this.viewport.width;
    this.pageHeight = this.viewport.height;
    this.pageRatio = this.pageWidth / this.pageHeight;

    this.canvasWidth = THUMBNAIL_WIDTH;
    this.canvasHeight = (this.canvasWidth / this.pageRatio) | 0;
    this.scale = this.canvasWidth / this.pageWidth;

    this.l10n = l10n;

    const anchor = document.createElement("a");
    anchor.href = linkService.getAnchorUrl("#page=" + id);
    this._thumbPageTitle.then(msg => {
      anchor.title = msg;
    });
    anchor.onclick = function () {
      linkService.goToPage(id);
      return false;
    };
    this.anchor = anchor;

    const div = document.createElement("div");
    div.className = "thumbnail";
    div.setAttribute("data-page-number", this.id);
    this.div = div;

    const ring = document.createElement("div");
    ring.className = "thumbnailSelectionRing";
    const borderAdjustment = 2 * THUMBNAIL_CANVAS_BORDER_WIDTH;
    ring.style.width = this.canvasWidth + borderAdjustment + "px";
    ring.style.height = this.canvasHeight + borderAdjustment + "px";
    this.ring = ring;

    div.appendChild(ring);
    anchor.appendChild(div);
    container.appendChild(anchor);
  }

  setPdfPage(pdfPage) {
    this.pdfPage = pdfPage;
    this.pdfPageRotate = pdfPage.rotate;
    const totalRotation = (this.rotation + this.pdfPageRotate) % 360;
    this.viewport = pdfPage.getViewport({ scale: 1, rotation: totalRotation });
    this.reset();
  }

  reset() {
    this.cancelRendering();
    this.renderingState = RenderingStates.INITIAL;

    this.pageWidth = this.viewport.width;
    this.pageHeight = this.viewport.height;
    this.pageRatio = this.pageWidth / this.pageHeight;

    this.canvasHeight = (this.canvasWidth / this.pageRatio) | 0;
    this.scale = this.canvasWidth / this.pageWidth;

    this.div.removeAttribute("data-loaded");
    const ring = this.ring;
    const childNodes = ring.childNodes;
    for (let i = childNodes.length - 1; i >= 0; i--) {
      ring.removeChild(childNodes[i]);
    }
    const borderAdjustment = 2 * THUMBNAIL_CANVAS_BORDER_WIDTH;
    ring.style.width = this.canvasWidth + borderAdjustment + "px";
    ring.style.height = this.canvasHeight + borderAdjustment + "px";

    if (this.canvas) {
      // Zeroing the width and height causes Firefox to release graphics
      // resources immediately, which can greatly reduce memory consumption.
      this.canvas.width = 0;
      this.canvas.height = 0;
      delete this.canvas;
    }
    if (this.image) {
      this.image.removeAttribute("src");
      delete this.image;
    }
  }

  update(rotation) {
    if (typeof rotation !== "undefined") {
      this.rotation = rotation;
    }
    const totalRotation = (this.rotation + this.pdfPageRotate) % 360;
    this.viewport = this.viewport.clone({
      scale: 1,
      rotation: totalRotation,
    });
    this.reset();
  }

  /**
   * PLEASE NOTE: Most likely you want to use the `this.reset()` method,
   *              rather than calling this one directly.
   */
  cancelRendering() {
    if (this.renderTask) {
      this.renderTask.cancel();
      this.renderTask = null;
    }
    this.resume = null;
  }

  /**
   * @private
   */
  _getPageDrawContext() {
    const canvas = document.createElement("canvas");
    // Keep the no-thumbnail outline visible, i.e. `data-loaded === false`,
    // until rendering/image conversion is complete, to avoid display issues.
    this.canvas = canvas;

    if (
      typeof PDFJSDev === "undefined" ||
      PDFJSDev.test("MOZCENTRAL || GENERIC")
    ) {
      canvas.mozOpaque = true;
    }
    const ctx = canvas.getContext("2d", { alpha: false });
    const outputScale = getOutputScale(ctx);

    canvas.width = (this.canvasWidth * outputScale.sx) | 0;
    canvas.height = (this.canvasHeight * outputScale.sy) | 0;
    canvas.style.width = this.canvasWidth + "px";
    canvas.style.height = this.canvasHeight + "px";

    const transform = outputScale.scaled
      ? [outputScale.sx, 0, 0, outputScale.sy, 0, 0]
      : null;

    return [ctx, transform];
  }

  /**
   * @private
   */
  _convertCanvasToImage() {
    if (!this.canvas) {
      return;
    }
    if (this.renderingState !== RenderingStates.FINISHED) {
      return;
    }
    window.drawAnnotations(this.canvas, this.viewport, this.pdfPage.pageNumber - 1);
    const className = "thumbnailImage";

    if (this.disableCanvasToImageConversion) {
      this.canvas.className = className;
      this._thumbPageCanvas.then(msg => {
        this.canvas.setAttribute("aria-label", msg);
      });

      this.div.setAttribute("data-loaded", true);
      this.ring.appendChild(this.canvas);
      return;
    }
    const image = document.createElement("img");
    image.className = className;
    this._thumbPageCanvas.then(msg => {
      image.setAttribute("aria-label", msg);
    });

    image.style.width = this.canvasWidth + "px";
    image.style.height = this.canvasHeight + "px";

    image.src = this.canvas.toDataURL();
    this.image = image;

    this.div.setAttribute("data-loaded", true);
    this.ring.appendChild(image);

    // Zeroing the width and height causes Firefox to release graphics
    // resources immediately, which can greatly reduce memory consumption.
    this.canvas.width = 0;
    this.canvas.height = 0;
    delete this.canvas;
  }

  draw() {
    if (this.renderingState !== RenderingStates.INITIAL) {
      console.error("Must be in new state before drawing");
      return Promise.resolve(undefined);
    }
    const { pdfPage } = this;

    if (!pdfPage) {
      this.renderingState = RenderingStates.FINISHED;
      return Promise.reject(new Error("pdfPage is not loaded"));
    }

    this.renderingState = RenderingStates.RUNNING;

    const finishRenderTask = async (error = null) => {
      // The renderTask may have been replaced by a new one, so only remove
      // the reference to the renderTask if it matches the one that is
      // triggering this callback.
      if (renderTask === this.renderTask) {
        this.renderTask = null;
      }

      if (error instanceof RenderingCancelledException) {
        return;
      }

      this.renderingState = RenderingStates.FINISHED;
      this._convertCanvasToImage();

      if (error) {
        throw error;
      }
    };

    const [ctx, transform] = this._getPageDrawContext();
    const drawViewport = this.viewport.clone({ scale: this.scale });
    const renderContinueCallback = cont => {
      if (!this.renderingQueue.isHighestPriority(this)) {
        this.renderingState = RenderingStates.PAUSED;
        this.resume = () => {
          this.renderingState = RenderingStates.RUNNING;
          cont();
        };
        return;
      }
      cont();
    };

    const renderContext = {
      canvasContext: ctx,
      transform,
      viewport: drawViewport,
      optionalContentConfigPromise: this._optionalContentConfigPromise,
    };
    const renderTask = (this.renderTask = pdfPage.render(renderContext));
    renderTask.onContinue = renderContinueCallback;

    const resultPromise = renderTask.promise.then(
      function () {
        finishRenderTask(null);
      },
      function (error) {
        finishRenderTask(error);
      }
    );
    // Only trigger cleanup, once rendering has finished, when the current
    // pageView is *not* cached on the `BaseViewer`-instance.
    resultPromise.finally(() => {
      const pageCached = this.linkService.isPageCached(this.id);
      if (pageCached) {
        return;
      }
      this.pdfPage?.cleanup();
    });

    return resultPromise;
  }

  setImage(pageView) {
    if (this._checkSetImageDisabled()) {
      return;
    }
    if (this.renderingState !== RenderingStates.INITIAL) {
      return;
    }
    const img = pageView.canvas;
    if (!img) {
      return;
    }
    if (!this.pdfPage) {
      this.setPdfPage(pageView.pdfPage);
    }

    this.renderingState = RenderingStates.FINISHED;

    const [ctx] = this._getPageDrawContext();
    const canvas = ctx.canvas;
    if (img.width <= 2 * canvas.width) {
      ctx.drawImage(
        img,
        0,
        0,
        img.width,
        img.height,
        0,
        0,
        canvas.width,
        canvas.height
      );
      this._convertCanvasToImage();
      return;
    }

    // drawImage does an awful job of rescaling the image, doing it gradually.
    let reducedWidth = canvas.width << MAX_NUM_SCALING_STEPS;
    let reducedHeight = canvas.height << MAX_NUM_SCALING_STEPS;
    const reducedImage = TempImageFactory.getCanvas(
      reducedWidth,
      reducedHeight
    );
    const reducedImageCtx = reducedImage.getContext("2d");

    while (reducedWidth > img.width || reducedHeight > img.height) {
      reducedWidth >>= 1;
      reducedHeight >>= 1;
    }
    reducedImageCtx.drawImage(
      img,
      0,
      0,
      img.width,
      img.height,
      0,
      0,
      reducedWidth,
      reducedHeight
    );
    while (reducedWidth > 2 * canvas.width) {
      reducedImageCtx.drawImage(
        reducedImage,
        0,
        0,
        reducedWidth,
        reducedHeight,
        0,
        0,
        reducedWidth >> 1,
        reducedHeight >> 1
      );
      reducedWidth >>= 1;
      reducedHeight >>= 1;
    }
    ctx.drawImage(
      reducedImage,
      0,
      0,
      reducedWidth,
      reducedHeight,
      0,
      0,
      canvas.width,
      canvas.height
    );
    this._convertCanvasToImage();
  }

  get _thumbPageTitle() {
    return this.l10n.get(
      "thumb_page_title",
      { page: this.pageLabel ?? this.id },
      "Page {{page}}"
    );
  }

  get _thumbPageCanvas() {
    return this.l10n.get(
      "thumb_page_canvas",
      { page: this.pageLabel ?? this.id },
      "Thumbnail of Page {{page}}"
    );
  }

  /**
   * @param {string|null} label
   */
  setPageLabel(label) {
    this.pageLabel = typeof label === "string" ? label : null;

    this._thumbPageTitle.then(msg => {
      this.anchor.title = msg;
    });

    if (this.renderingState !== RenderingStates.FINISHED) {
      return;
    }

    this._thumbPageCanvas.then(msg => {
      if (this.image) {
        this.image.setAttribute("aria-label", msg);
      } else if (this.disableCanvasToImageConversion && this.canvas) {
        this.canvas.setAttribute("aria-label", msg);
      }
    });
  }
}

export { PDFThumbnailView, TempImageFactory };
