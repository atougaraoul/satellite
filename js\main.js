// Shared utilities for the site
document.addEventListener('DOMContentLoaded', function(){
  const years = ['year','year2','year3','year4','year5'];
  years.forEach(id => {
    const el = document.getElementById(id);
    if(el) el.textContent = new Date().getFullYear();
  });
});
