const toggle = document.querySelector(".nav-toggle");
const nav = document.querySelector(".site-nav");
const navLinks = [...document.querySelectorAll('.site-nav a[href^="#"]')];

function closeNavigation() {
  document.body.classList.remove("nav-open");
  toggle?.setAttribute("aria-expanded", "false");
}

toggle?.addEventListener("click", () => {
  const open = document.body.classList.toggle("nav-open");
  toggle.setAttribute("aria-expanded", String(open));
});

navLinks.forEach((link) => link.addEventListener("click", closeNavigation));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeNavigation();
});

document.addEventListener("click", (event) => {
  if (!document.body.classList.contains("nav-open")) return;
  if (!nav?.contains(event.target) && !toggle?.contains(event.target)) closeNavigation();
});

const observedSections = navLinks
  .map((link) => document.querySelector(link.getAttribute("href")))
  .filter(Boolean);

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
    if (!visible) return;
    navLinks.forEach((link) => {
      const active = link.getAttribute("href") === `#${visible.target.id}`;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  }, { rootMargin: "-18% 0px -68%", threshold: [0, .15, .4] });
  observedSections.forEach((section) => observer.observe(section));
}

const year = document.querySelector("#current-year");
if (year) year.textContent = String(new Date().getFullYear());
