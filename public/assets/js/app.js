(function () {
  "use strict";

  var sidebar = document.getElementById("sidebar");
  var backdrop = document.getElementById("sidebarBackdrop");
  var toggle = document.getElementById("menuToggle");

  function closeSidebar() {
    if (sidebar) sidebar.classList.remove("open");
    if (backdrop) backdrop.classList.remove("open");
  }

  if (toggle && sidebar) {
    toggle.addEventListener("click", function () {
      sidebar.classList.toggle("open");
      if (backdrop) backdrop.classList.toggle("open", sidebar.classList.contains("open"));
    });
  }
  if (backdrop) backdrop.addEventListener("click", closeSidebar);
  document.querySelectorAll(".sidebar-nav a").forEach(function (link) {
    link.addEventListener("click", function () {
      if (window.innerWidth <= 960) closeSidebar();
    });
  });

  document.querySelectorAll("[data-confirm]").forEach(function (el) {
    el.addEventListener("submit", function (event) {
      if (!window.confirm(el.getAttribute("data-confirm") || "Are you sure?")) {
        event.preventDefault();
      }
    });
  });
  document.querySelectorAll("[data-confirm-click]").forEach(function (el) {
    el.addEventListener("click", function (event) {
      if (!window.confirm(el.getAttribute("data-confirm-click") || "Are you sure?")) {
        event.preventDefault();
      }
    });
  });

  document.querySelectorAll("[data-print]").forEach(function (el) {
    el.addEventListener("click", function (event) {
      event.preventDefault();
      window.print();
    });
  });

  document.querySelectorAll(".toast").forEach(function (toast) {
    window.setTimeout(function () {
      toast.style.transition = "opacity .3s";
      toast.style.opacity = "0";
      window.setTimeout(function () { toast.remove(); }, 350);
    }, 4200);
  });

  document.querySelectorAll("[data-toggle-target]").forEach(function (el) {
    el.addEventListener("click", function () {
      var target = document.querySelector(el.getAttribute("data-toggle-target"));
      if (!target) return;
      target.classList.toggle("open");
    });
  });

  document.querySelectorAll("[data-search-form]").forEach(function (form) {
    var input = form.querySelector("input[type=search]");
    if (!input) return;
    var timer = null;
    input.addEventListener("input", function () {
      window.clearTimeout(timer);
      timer = window.setTimeout(function () { form.submit(); }, 450);
    });
  });

  document.querySelectorAll("[data-reveal]").forEach(function (el) {
    el.addEventListener("click", function () {
      var target = document.querySelector(el.getAttribute("data-reveal"));
      if (target) {
        target.hidden = !target.hidden;
        if (!target.hidden) target.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  });

  var cartKey = document.querySelector("[data-pos-cart]");
  if (cartKey) {
    var form = document.querySelector("[data-pos-form]");
    if (form) {
      form.addEventListener("submit", function () {
        var button = form.querySelector("button[type=submit]");
        if (button) {
          button.disabled = true;
          button.dataset.label = button.textContent;
          button.textContent = "Saving...";
        }
      });
    }
  }

  window.ERP = { closeSidebar: closeSidebar };
})();
