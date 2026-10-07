document.addEventListener("DOMContentLoaded", () => {
  const links = document.querySelectorAll(".sidebar nav a, .side-bottom a");

  links.forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      links.forEach((item) => item.classList.remove("active"));
      link.classList.add("active");
    });
  });
});
