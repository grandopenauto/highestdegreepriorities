document.addEventListener('click', function (event) {
  const link = event.target.closest('a[href]');
  if (!link || typeof window.gtag !== 'function') return;

  const href = link.href || '';
  let eventName = '';

  if (link.id === 'sendInquiry' && document.getElementById('transportIntake')) {
    eventName = 'structured_inquiry_clicked';
  } else if (href.includes('calendly.com/hgerling2/growth_assessment')) {
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

  const params = {
    link_url: href,
    link_text: (link.textContent || '').trim().slice(0, 120),
    page_location: window.location.href
  };

  if (eventName === 'structured_inquiry_clicked') {
    params.transport_role = document.getElementById('role')?.value || '';
    params.transport_need = document.getElementById('need')?.value || '';
    params.transport_fleet_stage = document.getElementById('fleet')?.value || '';
  }

  window.gtag('event', eventName, params);
});

(function () {
  const form = document.getElementById('transportIntake');
  if (!form) return;

  let started = false;
  const markStarted = function () {
    if (started || typeof window.gtag !== 'function') return;
    started = true;
    window.gtag('event', 'intake_started', {
      page_location: window.location.href
    });
  };

  form.addEventListener('focusin', markStarted, { once: true });
  form.addEventListener('input', markStarted, { once: true });

  form.addEventListener('submit', function () {
    if (typeof window.gtag !== 'function') return;
    window.gtag('event', 'route_built', {
      transport_role: document.getElementById('role')?.value || '',
      transport_need: document.getElementById('need')?.value || '',
      transport_fleet_stage: document.getElementById('fleet')?.value || '',
      page_location: window.location.href
    });
  });
})();
