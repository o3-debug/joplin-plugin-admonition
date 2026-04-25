(function () {
  'use strict';

  var MARKER_ATTRIBUTE = 'data-admonition-enhanced';

  function setExpandedState(block, titleElement) {
    var expanded = !block.classList.contains('is-collapsed');
    titleElement.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function attachToggleHandlers(block, titleElement) {
    var toggle = function () {
      block.classList.toggle('is-collapsed');
      setExpandedState(block, titleElement);
    };

    titleElement.addEventListener('click', function (event) {
      event.preventDefault();
      toggle();
    });

    titleElement.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });

    setExpandedState(block, titleElement);
  }

  function parseInitialState(rawTitle) {
    var title = rawTitle || '';
    var trimmed = title.replace(/^\s+/, '');
    var collapsed = false;

    var marker = trimmed.match(/^\[(\+|-|collapse|fold)\]\s*/i);
    if (marker) {
      collapsed = marker[1] !== '-';
      title = trimmed.slice(marker[0].length);
      return { title: title, collapsed: collapsed };
    }

    return { title: title, collapsed: false };
  }

  function enhanceAdmonitions() {
    var blocks = document.querySelectorAll('.admonition');

    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (block.getAttribute(MARKER_ATTRIBUTE) === '1') continue;

      var titleElement = null;
      for (var j = 0; j < block.children.length; j++) {
        if (block.children[j].classList.contains('admonition-title')) {
          titleElement = block.children[j];
          break;
        }
      }

      if (!titleElement) {
        block.setAttribute(MARKER_ATTRIBUTE, '1');
        continue;
      }

      var state = parseInitialState(titleElement.textContent || '');
      titleElement.textContent = state.title;

      var contentWrapper = document.createElement('div');
      contentWrapper.className = 'admonition-content';

      var node = titleElement.nextSibling;
      while (node) {
        var next = node.nextSibling;
        contentWrapper.appendChild(node);
        node = next;
      }

      if (!contentWrapper.childNodes.length) {
        block.setAttribute(MARKER_ATTRIBUTE, '1');
        continue;
      }

      block.appendChild(contentWrapper);
      block.classList.add('admonition-collapsible');
      if (state.collapsed) {
        block.classList.add('is-collapsed');
      }

      titleElement.setAttribute('role', 'button');
      titleElement.setAttribute('tabindex', '0');

      attachToggleHandlers(block, titleElement);

      block.setAttribute(MARKER_ATTRIBUTE, '1');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhanceAdmonitions);
  } else {
    enhanceAdmonitions();
  }

  if (typeof MutationObserver !== 'undefined') {
    var observer = new MutationObserver(function () {
      enhanceAdmonitions();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }
})();
