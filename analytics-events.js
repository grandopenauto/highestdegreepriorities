(function () {
  const QA_KEY = 'hdp_internal_qa';
  const params = new URLSearchParams(window.location.search);
  const source = (params.get('utm_source') || '').toLowerCase();
  const medium = (params.get('utm_medium') || '').toLowerCase();
  const qaFlag = params.get('hdp_qa');

  try {
    if (qaFlag === '1' || source === 'hdp_internal' || medium === 'qa') {
      window.localStorage.setItem(QA_KEY, '1');
    } else if (qaFlag === '0') {
      window.localStorage.removeItem(QA_KEY);
    }
    window.__HDP_INTERNAL_QA__ = window.localStorage.getItem(QA_KEY) === '1';
  } catch (_) {
    window.__HDP_INTERNAL_QA__ = qaFlag === '1' || source === 'hdp_internal' || medium === 'qa';
  }
})();

function hdpTrackEvent(eventName, params) {
  if (!eventName || typeof window.gtag !== 'function') return;

  const internalQa = window.__HDP_INTERNAL_QA__ === true;
  const emittedName = internalQa ? `internal_qa_${eventName}` : eventName;

  window.gtag('event', emittedName, {
    ...(params || {}),
    hdp_traffic_class: internalQa ? 'internal_qa' : 'unclassified'
  });
}

document.addEventListener('click', function (event) {
  const link = event.target.closest('a[href]');
  if (!link || typeof window.gtag !== 'function') return;

  const href = link.href || '';
  let eventName = '';

  const explicitEvent = link.dataset?.analytics || '';
  if (explicitEvent) eventName = explicitEvent;

  if (!eventName && link.id === 'sendInquiry' && document.getElementById('transportIntake')) {
    eventName = 'structured_inquiry_clicked';
  } else if (!eventName && href.includes('calendly.com/hgerling2/growth_assessment')) {
    eventName = 'assessment_start';
  } else if (!eventName && href.includes('/leadgen-demo/')) {
    eventName = 'lead_system_demo';
  } else if (!eventName && href.includes('offer.highestdegreepriorities.com')) {
    eventName = 'workflow_rescue_interest';
  } else if (!eventName && href.includes('buy.stripe.com/')) {
    eventName = 'resume_builder_checkout';
  } else if (!eventName && href.includes('sms-opt-in.html')) {
    eventName = 'sms_opt_in_view';
  } else if (!eventName && href.startsWith('mailto:contact@highestdegreepriorities.com')) {
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

  hdpTrackEvent(eventName, params);
});

(function () {
  const form = document.getElementById('transportIntake');
  if (!form) return;

  let started = false;
  const markStarted = function () {
    if (started || typeof window.gtag !== 'function') return;
    started = true;
    hdpTrackEvent('intake_started', {
      page_location: window.location.href
    });
  };

  form.addEventListener('focusin', markStarted, { once: true });
  form.addEventListener('input', markStarted, { once: true });

  form.addEventListener('submit', function () {
    if (typeof window.gtag !== 'function') return;
    hdpTrackEvent('route_built', {
      transport_role: document.getElementById('role')?.value || '',
      transport_need: document.getElementById('need')?.value || '',
      transport_fleet_stage: document.getElementById('fleet')?.value || '',
      page_location: window.location.href
    });
  });
})();
