document.addEventListener('click', function (event) {
  const link = event.target.closest('a[href]');
  if (!link || typeof window.gtag !== 'function') return;

  const href = link.href || '';
  let eventName = '';

  if (href.includes('calendly.com/hgerling2/growth_assessment')) {
    eventName = 'assessment_start';
  } else if (href.includes('/leadgen-demo/')) {
    eventName = 'lead_system_demo';
  } else if (href.includes('offer.highestdegreepriorities.com')) {
    eventName = 'workflow_rescue_interest';
  } else if (href.includes('buy.stripe.com/')) {
    eventName = 'resume_builder_checkout';
  } else if (href.includes('sms-opt-in.html')) {
    eventName = 'sms_opt_in_view';
  } else if (href.startsWith('mailto:contact@highestdegreepriorities.com')) {
    eventName = 'contact_email_click';
  }

  if (!eventName) return;

  window.gtag('event', eventName, {
    link_url: href,
    link_text: (link.textContent || '').trim().slice(0, 120),
    page_location: window.location.href
  });
});
